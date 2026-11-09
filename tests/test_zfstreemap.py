import json
import threading
import unittest
import urllib.error
import urllib.request

from zfstreemap import zfs
from zfstreemap.server import make_server

# `zfs list -H -p -t filesystem,volume -o name,type,used,usedbysnapshots,referenced,mountpoint`
DATASETS_OUT = "\n".join(
    [
        "tank\tfilesystem\t1000\t100\t50\t400\t/tank",
        "tank/home\tfilesystem\t600\t200\t300\t350\t/home",
        "tank/home/jim\tfilesystem\t300\t0\t300\t350\t/home/jim",
        "tank/vol\tvolume\t150\t50\t100\t400\t-",
        "other\tfilesystem\t40\t0\t40\t60\t/other",
    ]
)

# `zfs list -H -p -t snapshot -o name,creation`
SNAPSHOTS_OUT = "\n".join(
    [
        "tank@a\t1700000000",
        "tank@b\t1700000500",
        "tank/home@x\t1600000000",
        "tank/home@y\t1800000000",
        "tank/home@z\t1750000000",
    ]
)


def fake_runner(args):
    if args[:2] == ["list", "-H"] and "snapshot" in args:
        return SNAPSHOTS_OUT + "\n"
    if args[:2] == ["list", "-H"]:
        return DATASETS_OUT + "\n"
    raise AssertionError(f"unexpected zfs call: {args}")


def by_name(node, name):
    if node["name"] == name:
        return node
    for child in node["children"]:
        found = by_name(child, name)
        if found is not None:
            return found
    return None


class ParseTests(unittest.TestCase):
    def test_parse_dataset_line_keeps_mountpoint_intact(self):
        ds = zfs.parse_dataset_line("tank\tfilesystem\t1\t2\t3\t4\t/mnt/with spaces")
        self.assertEqual((ds.name, ds.type, ds.used, ds.snapshot_space, ds.referenced, ds.available), ("tank", "filesystem", 1, 2, 3, 4))
        self.assertEqual(ds.mountpoint, "/mnt/with spaces")

    def test_list_snapshots_summarises_per_dataset(self):
        summaries = zfs.list_snapshots(fake_runner)
        self.assertEqual(summaries["tank"].count, 2)
        self.assertEqual(summaries["tank"].oldest, 1700000000)
        self.assertEqual(summaries["tank"].newest, 1700000500)
        self.assertEqual(summaries["tank/home"].count, 3)
        self.assertEqual(summaries["tank/home"].oldest, 1600000000)
        self.assertEqual(summaries["tank/home"].newest, 1800000000)
        self.assertNotIn("other", summaries)


class TreeTests(unittest.TestCase):
    def setUp(self):
        self.tree = zfs.collect_tree(fake_runner)
        self.root = self.tree["root"]

    def test_pools_are_top_level_children_of_virtual_root(self):
        self.assertEqual(self.root["type"], "root")
        self.assertEqual([c["name"] for c in self.root["children"]], ["other", "tank"])
        self.assertEqual(self.root["used"], 1040)

    def test_children_nest_under_parent(self):
        tank = by_name(self.root, "tank")
        self.assertEqual([c["name"] for c in tank["children"]], ["tank/home", "tank/vol"])
        home = by_name(self.root, "tank/home")
        self.assertEqual([c["name"] for c in home["children"]], ["tank/home/jim"])

    def test_own_data_is_remainder_after_snapshots_and_children(self):
        tank = by_name(self.root, "tank")
        # used 1000 = own + snapshots 100 + children (home 600 + vol 150) -> own 150
        self.assertEqual(tank["own"], 150)
        home = by_name(self.root, "tank/home")
        # used 600 = own + snapshots 200 + child jim 300 -> own 100
        self.assertEqual(home["own"], 100)
        jim = by_name(self.root, "tank/home/jim")
        self.assertEqual(jim["own"], 300)

    def test_every_box_splits_exactly_into_its_parts(self):
        def check(node):
            if node["type"] == "root":
                return
            parts = node["own"] + node["snapshot_space"] + sum(c["used"] for c in node["children"])
            self.assertEqual(parts, node["used"], node["name"])
            for child in node["children"]:
                check(child)

        check(self.root)

    def test_snapshot_summary_is_attached_to_dataset(self):
        home = by_name(self.root, "tank/home")
        self.assertEqual(home["snapshot_count"], 3)
        self.assertEqual(home["snapshot_oldest"], 1600000000)
        self.assertEqual(home["snapshot_newest"], 1800000000)
        jim = by_name(self.root, "tank/home/jim")
        self.assertEqual(jim["snapshot_count"], 0)
        self.assertIsNone(jim["snapshot_oldest"])

    def test_volume_is_included_as_leaf(self):
        vol = by_name(self.root, "tank/vol")
        self.assertEqual(vol["type"], "volume")
        self.assertEqual(vol["children"], [])
        self.assertEqual(vol["own"], 100)

    def test_pools_carry_free_space_and_root_sums_it(self):
        other = by_name(self.root, "other")
        tank = by_name(self.root, "tank")
        self.assertEqual(tank["free"], 400)
        self.assertEqual(other["free"], 60)
        self.assertEqual(self.root["free"], 460)
        self.assertIsNone(by_name(self.root, "tank/home")["free"])

    def test_negative_remainder_is_clamped_to_zero(self):
        ds = [zfs.Dataset("p", "filesystem", 100, 0, 0, 0, "/p"), zfs.Dataset("p/c", "filesystem", 150, 0, 0, 0, "/c")]
        root = zfs.build_tree(ds, {})
        self.assertEqual(root.children[0].own, 0)


class RunnerTests(unittest.TestCase):
    def test_missing_zfs_binary_raises_zfs_error(self):
        original = zfs.ZFS_COMMAND
        zfs.ZFS_COMMAND = "/nonexistent/zfs-binary-for-tests"
        try:
            with self.assertRaises(zfs.ZFSError):
                zfs.run_zfs(["list"])
        finally:
            zfs.ZFS_COMMAND = original


class ServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = make_server("127.0.0.1", 0, runner=fake_runner)
        cls.base = "http://127.0.0.1:%d" % cls.server.server_address[1]
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def get(self, path):
        try:
            with urllib.request.urlopen(self.base + path) as resp:
                return resp.status, resp.headers.get("Content-Type"), resp.read()
        except urllib.error.HTTPError as exc:
            return exc.code, exc.headers.get("Content-Type"), exc.read()

    def test_index_page_is_served(self):
        status, ctype, body = self.get("/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", ctype)
        self.assertIn(b"/app.js", body)

    def test_static_assets_are_served(self):
        for path, ctype in [("/app.js", "javascript"), ("/style.css", "text/css")]:
            status, got_type, _ = self.get(path)
            self.assertEqual(status, 200, path)
            self.assertIn(ctype, got_type)

    def test_api_returns_tree_json(self):
        status, ctype, body = self.get("/api/tree")
        self.assertEqual(status, 200)
        self.assertEqual(ctype, "application/json")
        data = json.loads(body)
        self.assertEqual(data["root"]["name"], "")
        self.assertIsInstance(data["generated"], int)

    def test_unknown_path_is_404(self):
        status, _, _ = self.get("/nope")
        self.assertEqual(status, 404)

    def test_zfs_failure_is_reported_as_json_error(self):
        def failing(args):
            raise zfs.ZFSError("permission denied")

        server = make_server("127.0.0.1", 0, runner=failing)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            url = "http://127.0.0.1:%d/api/tree" % server.server_address[1]
            with self.assertRaises(urllib.error.HTTPError) as ctx:
                urllib.request.urlopen(url)
            self.assertEqual(ctx.exception.code, 500)
            self.assertEqual(json.loads(ctx.exception.read()), {"error": "permission denied"})
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
