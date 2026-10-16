"""Load Soya3D / Slune .data pickles (Python 2, protocol 1) without Soya.

Every class reference is replaced by a Stub that records the class name and
whatever state pickle hands to it, so the raw Soya C-state can be decoded
separately (see soyadecode.py).
"""
import pickle, sys


class Stub:
    cls = "?"

    def __init__(self, *a, **k):
        self.args = a

    def __setstate__(self, state):
        self.state = state

    def __repr__(self):
        return "<%s>" % self.cls


_classes = {}


def stub_class(module, name):
    key = module + "." + name
    if key not in _classes:
        _classes[key] = type(name, (Stub,), {"cls": key})
    return _classes[key]


def _reconstructor(clazz, *a):
    return clazz.__new__(clazz)


class Loaded:
    """Reference to another Soya file (soya._loader / soya._getter)."""

    def __init__(self, kind, *args):
        self.kind, self.args = kind, args

    def __repr__(self):
        return "<ref %s %r>" % (self.kind, self.args)


class SoyaUnpickler(pickle.Unpickler):
    def find_class(self, module, name):
        if name == "_reconstructor":
            return _reconstructor
        if name in ("_loader", "_getter"):
            return lambda *a: Loaded(name, *a)
        if module.startswith(("soya", "csoya", "slune", "balazar", "soyapyrex", "_soya")) or module in ("__main__",):
            return stub_class(module, name)
        if module == "copy_reg" and name == "_reconstructor":
            return lambda cls, base, state: cls.__new__(cls)
        if module == "__builtin__":
            import builtins
            return getattr(builtins, name)
        return stub_class(module, name)


def load(path):
    with open(path, "rb") as f:
        return SoyaUnpickler(f, encoding="bytes").load()


def dump(o, depth=0, maxdepth=4, seen=None):
    seen = seen if seen is not None else set()
    pad = "  " * depth
    if isinstance(o, Stub):
        if id(o) in seen:
            return pad + "<%s (seen)>" % o.cls
        seen.add(id(o))
        out = [pad + "<%s>" % o.cls]
        if depth < maxdepth:
            out.append(dump(getattr(o, "state", None), depth + 1, maxdepth, seen))
        return "\n".join(out)
    if isinstance(o, (list, tuple)):
        if depth >= maxdepth:
            return pad + "%s[%d]" % (type(o).__name__, len(o))
        return "\n".join([pad + "%s[%d]" % (type(o).__name__, len(o))] + [dump(x, depth + 1, maxdepth, seen) for x in o[:12]] + ([pad + "  ..."] if len(o) > 12 else []))
    if isinstance(o, dict):
        out = [pad + "dict"]
        for k, v in o.items():
            out.append(pad + "  %r:" % (k,))
            out.append(dump(v, depth + 2, maxdepth, seen))
        return "\n".join(out)
    if isinstance(o, bytes):
        return pad + ("bytes[%d] %r" % (len(o), o[:24]))
    return pad + repr(o)[:120]


if __name__ == "__main__":
    for p in sys.argv[1:]:
        print("=====", p)
        print(dump(load(p), maxdepth=int(__import__("os").environ.get("DEPTH", 4))))
