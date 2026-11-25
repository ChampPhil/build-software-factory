"""
Build the viewable artifact for the Phase 1 sketch.

Reads every file under design/sketch from a git commit (HEAD by default) and
embeds it unchanged in bundle/shell.html: text files as text, binary files
as base64. The page assembles each direction in the browser, so what you see
in the artifact is made from exactly the committed bytes.

    python design/sketch/bundle/build.py [out.html] [commit]
    python design/sketch/bundle/verify.py out.html [commit]
"""
import base64, json, subprocess, sys, pathlib

SKETCH = "design/sketch"
SKIP = (f"{SKETCH}/screens/", f"{SKETCH}/bundle/")   # screenshots and this tool aren't part of the pages


def committed_files(commit):
    names = subprocess.run(["git", "ls-tree", "-r", "--name-only", commit, SKETCH + "/"], check=True, capture_output=True, text=True).stdout.split()
    for name in names:
        if name.startswith(SKIP) or name.endswith(".md"):
            continue
        data = subprocess.run(["git", "show", f"{commit}:{name}"], check=True, capture_output=True).stdout
        yield name[len(SKETCH) + 1:], data


def entry(data):
    try:
        return {"text": data.decode("utf-8")}
    except UnicodeDecodeError:
        return {"base64": base64.b64encode(data).decode("ascii")}


def main():
    out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "sketch-artifact.html")
    commit = sys.argv[2] if len(sys.argv) > 2 else "HEAD"
    files = {path: entry(data) for path, data in committed_files(commit)}
    shell = subprocess.run(["git", "show", f"{commit}:{SKETCH}/bundle/shell.html"], check=True, capture_output=True, text=True).stdout
    blob = json.dumps(files, ensure_ascii=False, sort_keys=True).replace("</", "<\\/")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(shell.replace("__FILES__", blob), encoding="utf-8", newline="")
    print(f"{out}: {len(files)} files from {commit}, {out.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
