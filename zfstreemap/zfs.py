"""Collect dataset and snapshot space usage from the ``zfs`` command line tool.

There is no stable public Python API for ZFS (libzfs_core needs the C library
headers and cffi), so this shells out to ``zfs list``. The flags keep the output
machine-friendly: ``-H`` drops the header, ``-p`` prints exact byte counts, and
columns are tab-separated.

Space model: a dataset's ``used`` is the sum of three disjoint parts:
the space held by its snapshots (``usedbysnapshots``), the space of its child
datasets (each child's own ``used``), and the remainder, which is the dataset's
own data. Those three parts are what the UI draws inside each dataset's box.
"""

from __future__ import annotations

import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

ZFS_COMMAND = "zfs"

# Runs ``zfs <args>`` and returns stdout. Injectable so tests need no ZFS.
Runner = Callable[[List[str]], str]


class ZFSError(RuntimeError):
    """The zfs command is missing or reported an error."""


def run_zfs(args: List[str]) -> str:
    cmd = [ZFS_COMMAND, *args]
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
    except FileNotFoundError as exc:
        raise ZFSError(f"{ZFS_COMMAND!r} not found; is ZFS installed?") from exc
    if proc.returncode != 0:
        detail = proc.stderr.strip() or f"exit status {proc.returncode}"
        raise ZFSError(f"'{' '.join(cmd)}' failed: {detail}")
    return proc.stdout


@dataclass
class Dataset:
    name: str
    type: str
    used: int
    snapshot_space: int
    referenced: int
    available: int
    mountpoint: str


@dataclass
class SnapshotSummary:
    count: int = 0
    oldest: Optional[int] = None  # creation time, seconds since the epoch
    newest: Optional[int] = None


@dataclass
class Node:
    name: str
    type: str  # "filesystem", "volume", or "root" for the virtual container of pools
    used: int = 0
    snapshot_space: int = 0
    referenced: int = 0
    mountpoint: str = ""
    snapshot_count: int = 0
    snapshot_oldest: Optional[int] = None
    snapshot_newest: Optional[int] = None
    own: int = 0
    free: Optional[int] = None  # pools and the root only: space available to datasets
    children: List["Node"] = field(default_factory=list)


DATASET_FIELDS = ["name", "type", "used", "usedbysnapshots", "referenced", "available", "mountpoint"]


def parse_dataset_line(line: str) -> Dataset:
    name, type_, used, snapshot_space, referenced, available, mountpoint = line.split("\t", 6)
    return Dataset(
        name=name,
        type=type_,
        used=int(used),
        snapshot_space=int(snapshot_space),
        referenced=int(referenced),
        available=int(available),
        mountpoint=mountpoint,
    )


def list_datasets(run: Runner = run_zfs) -> List[Dataset]:
    out = run(["list", "-H", "-p", "-t", "filesystem,volume", "-o", ",".join(DATASET_FIELDS)])
    return [parse_dataset_line(line) for line in out.splitlines() if line.strip()]


def list_snapshots(run: Runner = run_zfs) -> Dict[str, SnapshotSummary]:
    """Summarise snapshots per dataset. Individual snapshots are not kept."""
    out = run(["list", "-H", "-p", "-t", "snapshot", "-o", "name,creation"])
    summaries: Dict[str, SnapshotSummary] = {}
    for line in out.splitlines():
        if not line.strip():
            continue
        full_name, created_text = line.split("\t", 1)
        dataset_name, _, _ = full_name.partition("@")
        created = int(created_text)
        summary = summaries.setdefault(dataset_name, SnapshotSummary())
        summary.count += 1
        summary.oldest = created if summary.oldest is None else min(summary.oldest, created)
        summary.newest = created if summary.newest is None else max(summary.newest, created)
    return summaries


def build_tree(datasets: List[Dataset], snapshots: Dict[str, SnapshotSummary]) -> Node:
    root = Node(name="", type="root")
    nodes: Dict[str, Node] = {}
    for ds in datasets:
        is_pool = "/" not in ds.name
        nodes[ds.name] = Node(
            name=ds.name,
            type=ds.type,
            used=ds.used,
            snapshot_space=ds.snapshot_space,
            referenced=ds.referenced,
            mountpoint=ds.mountpoint,
            # The pool's root dataset reports the space its datasets can still use.
            free=ds.available if is_pool else None,
        )

    # Sorting puts every parent before its children, and siblings in name order.
    for name in sorted(nodes):
        parent_name = name.rpartition("/")[0]
        parent = nodes.get(parent_name, root)
        parent.children.append(nodes[name])

    for name, summary in snapshots.items():
        node = nodes.get(name)
        if node is not None:
            node.snapshot_count = summary.count
            node.snapshot_oldest = summary.oldest
            node.snapshot_newest = summary.newest

    _finish(root)
    return root


def _finish(node: Node) -> None:
    """Fill in derived sizes bottom-up. ``own`` is what remains after snapshots and children."""
    for child in node.children:
        _finish(child)
    if node.type == "root":
        node.used = sum(child.used for child in node.children)
        node.free = sum(child.free or 0 for child in node.children)
        return
    children_total = sum(child.used for child in node.children)
    node.own = max(0, node.used - node.snapshot_space - children_total)


def node_to_dict(node: Node) -> dict:
    return {
        "name": node.name,
        "type": node.type,
        "mountpoint": node.mountpoint,
        "used": node.used,
        "own": node.own,
        "free": node.free,
        "referenced": node.referenced,
        "snapshot_space": node.snapshot_space,
        "snapshot_count": node.snapshot_count,
        "snapshot_oldest": node.snapshot_oldest,
        "snapshot_newest": node.snapshot_newest,
        "children": [node_to_dict(child) for child in node.children],
    }


def collect_tree(run: Runner = run_zfs) -> dict:
    """Return the dataset tree as JSON-ready data, rooted at a virtual node for all pools."""
    # The two listings are independent, and listing snapshots is the slow part,
    # so run them concurrently. The subprocess calls release the GIL.
    with ThreadPoolExecutor(max_workers=2) as pool:
        datasets = pool.submit(list_datasets, run)
        snapshots = pool.submit(list_snapshots, run)
        root = build_tree(datasets.result(), snapshots.result())
    return {"generated": int(time.time()), "root": node_to_dict(root)}
