def add(a, b):
    return a + b


def parse_line(line):
    parts = line.split(None, 4)
    if len(parts) < 5:
        return None
    ts, lvl, src, *rest = parts
    msg = rest[-1]
    return {"ts": ts, "level": lvl, "source": src, "message": msg}


def is_error(line):
    return "ERROR" in line or "FATAL" in line
