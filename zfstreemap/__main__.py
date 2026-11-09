"""Command line entry point: ``python -m zfstreemap`` or the ``zfstreemap`` script."""

from __future__ import annotations

import argparse
from typing import List, Optional

from .server import make_server


def main(argv: Optional[List[str]] = None) -> None:
    parser = argparse.ArgumentParser(
        prog="zfstreemap",
        description="Serve an interactive treemap of ZFS dataset and snapshot space usage.",
    )
    parser.add_argument("--host", default="127.0.0.1", help="address to bind (default: %(default)s)")
    parser.add_argument("--port", type=int, default=8080, help="port to listen on (default: %(default)s)")
    args = parser.parse_args(argv)

    server = make_server(args.host, args.port)
    host, port = server.server_address[:2]
    print(f"zfstreemap listening on http://{host}:{port}/ (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
