"""Read a fresh snapshot of the app and its bundled runtime from psutil."""
import json
import sys

import psutil


def rss(pid):
    if pid <= 0:
        return 0
    try:
        return psutil.Process(pid).memory_info().rss
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return 0


def snapshot(root, acp, native, browser):
    process = psutil.Process(root)
    studio = rss(root)
    host = 0
    for child in process.children():
        try:
            if child.name().lower() in ("aelix-studio-host", "aelix-studio-host.exe"):
                host += rss(child.pid)
            else:
                studio += rss(child.pid)
                studio += sum(rss(item.pid) for item in child.children(recursive=True))
        except psutil.NoSuchProcess:
            continue
    if browser > 0:
        try:
            browser_process = psutil.Process(browser)
            studio += rss(browser) + sum(rss(child.pid) for child in browser_process.children(recursive=True))
        except psutil.NoSuchProcess:
            pass
    if sys.platform == "win32" and native > 0:
        # ACP owns a Windows Job gate. Its direct child runs the bundled worker.
        try:
            children = psutil.Process(native).children()
            native = children[0].pid if len(children) == 1 else 0
        except psutil.NoSuchProcess:
            native = 0
    return {"studio": studio, "host": host, "acp": rss(acp), "native": rss(native)}


for line in sys.stdin:
    try:
        print(json.dumps(snapshot(*map(int, line.split()))), flush=True)
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        print("{}", flush=True)
