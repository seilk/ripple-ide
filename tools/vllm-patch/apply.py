"""Apply (or check, or remove) the Ripple parser patch in an installed vLLM.

    python apply.py            # apply; safe to run again
    python apply.py --check    # exit 0 when applied
    python apply.py --revert   # put the original file back

Restart `vllm serve` after a change. Written for vLLM 0.34.0rc1.dev156; it stops with a
message when the file does not look as expected.
"""

import pathlib
import shutil
import sys

import vllm.parser.ripple as ripple

TARGET = pathlib.Path(ripple.__file__)
BACKUP = TARGET.with_suffix(".py.orig")
ANCHOR_DEF = "@functools.cache\ndef ripple_config()"
ANCHOR_USE = "        arg_converter=_ripple_arg_converter,\n"
USE = ANCHOR_USE + "        arg_value_extender=_ripple_arg_value_extender,\n"


def patch_source() -> str:
    text = (pathlib.Path(__file__).parent / "ripple_extender.py").read_text()
    return text.split("# --- begin patch ---\n")[1].split("# --- end patch ---")[0].rstrip() + "\n\n\n"


def main() -> int:
    source = TARGET.read_text()
    applied = "_ripple_arg_value_extender" in source
    if "--check" in sys.argv:
        print(f"{TARGET}: {'patched' if applied else 'not patched'}")
        return 0 if applied else 1
    if "--revert" in sys.argv:
        if not BACKUP.exists():
            print("no backup, nothing to revert")
            return 1
        shutil.copyfile(BACKUP, TARGET)
        print(f"reverted {TARGET}")
        return 0
    if applied:
        print(f"{TARGET}: already patched")
        return 0
    if source.count(ANCHOR_DEF) != 1 or source.count(ANCHOR_USE) != 1:
        print(f"{TARGET} does not look like the version this patch was written for; not changed")
        return 2
    shutil.copyfile(TARGET, BACKUP)
    patched = source.replace(ANCHOR_DEF, patch_source() + ANCHOR_DEF).replace(ANCHOR_USE, USE)
    TARGET.write_text(patched)
    print(f"patched {TARGET} (original kept at {BACKUP})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
