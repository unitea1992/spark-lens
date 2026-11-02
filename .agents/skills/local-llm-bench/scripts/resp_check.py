#!/usr/bin/env python3
"""Responses API vs Chat Completions check against a TensorFold server. stdlib only."""
import base64, json, struct, sys, time, urllib.request, zlib

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://pgx-head:8888/v1"
MODEL = sys.argv[2]
EFFORT = sys.argv[3] if len(sys.argv) > 3 else "low"
OUT = {}


def post(path, body, stream=False, timeout=600):
    req = urllib.request.Request(BASE + path, json.dumps(body).encode(), {"Content-Type": "application/json"})
    t0 = time.time()
    try:
        r = urllib.request.urlopen(req, timeout=timeout)
    except urllib.error.HTTPError as e:
        return {"http": e.code, "body": e.read().decode()[:400]}, time.time() - t0
    if not stream:
        return json.loads(r.read()), time.time() - t0
    events, first = [], None
    ev = None
    for raw in r:
        line = raw.decode().rstrip("\n")
        if line.startswith("event:"):
            ev = line[6:].strip()
        elif line.startswith("data:"):
            d = line[5:].strip()
            if d == "[DONE]":
                continue
            if first is None:
                first = time.time() - t0
            try:
                events.append((ev, json.loads(d)))
            except Exception:
                events.append((ev, d))
    return events, (first, time.time() - t0)


def png(rgb, n=64):
    row = b"\x00" + bytes(rgb) * n
    raw = row * n
    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", n, n, 8, 2, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b"")


def out_text(resp):
    if "output" not in resp:
        return None
    t = []
    for it in resp["output"]:
        if it.get("type") == "message":
            for c in it.get("content", []):
                t.append(c.get("text", ""))
    return "".join(t)


def kinds(resp):
    return [it.get("type") for it in resp.get("output", [])]


def check(name, fn):
    try:
        res = fn()
        print(f"[{name}] {res}")
        OUT[name] = res
    except Exception as e:
        print(f"[{name}] EXC {type(e).__name__}: {e}")
        OUT[name] = f"EXC {e}"


# 1 models
def t_models():
    r = urllib.request.urlopen(BASE + "/models", timeout=30)
    return [m["id"] for m in json.loads(r.read())["data"]]
check("models", t_models)

# 2 basic
def t_basic():
    r, dt = post("/responses", {"model": MODEL, "input": "Reply with exactly: PONG", "max_output_tokens": 2000, "reasoning": {"effort": EFFORT}})
    if "http" in r: return r
    return {"s": round(dt, 2), "status": r.get("status"), "kinds": kinds(r), "text": (out_text(r) or "")[:60], "usage": r.get("usage")}
check("basic", t_basic)

# 3 chat reference
def t_chat():
    r, dt = post("/chat/completions", {"model": MODEL, "messages": [{"role": "user", "content": "Reply with exactly: PONG"}], "max_tokens": 2000, "reasoning_effort": EFFORT})
    if "http" in r: return r
    m = r["choices"][0]["message"]
    return {"s": round(dt, 2), "text": (m.get("content") or "")[:60], "reasoning_field": [k for k in m if "reason" in k], "usage": r.get("usage")}
check("chat_ref", t_chat)

# 4 stream
def t_stream():
    ev, (ttft, total) = post("/responses", {"model": MODEL, "input": "Count from 1 to 5 in words.", "stream": True, "max_output_tokens": 2000, "reasoning": {"effort": EFFORT}}, stream=True)
    if isinstance(ev, dict): return ev
    types = []
    for e, _ in ev:
        if e not in types: types.append(e)
    done = [d for e, d in ev if e == "response.completed"]
    return {"ttft": round(ttft, 2), "total": round(total, 2), "event_types": types, "completed": bool(done), "usage": done[0]["response"].get("usage") if done else None}
check("stream", t_stream)

# 5 tools round trip
TOOLS = [{"type": "function", "name": "get_weather", "description": "Get weather for a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}]
def t_tools():
    msgs = [{"role": "user", "content": "What is the weather in Tokyo? Use the tool."}]
    r, dt = post("/responses", {"model": MODEL, "input": msgs, "tools": TOOLS, "max_output_tokens": 3000, "reasoning": {"effort": EFFORT}})
    if "http" in r: return r
    calls = [it for it in r["output"] if it.get("type") == "function_call"]
    if not calls: return {"no_call": kinds(r), "text": (out_text(r) or "")[:80]}
    c = calls[0]
    follow = msgs + r["output"] + [{"type": "function_call_output", "call_id": c["call_id"], "output": "Sunny, 21C"}]
    r2, dt2 = post("/responses", {"model": MODEL, "input": follow, "tools": TOOLS, "max_output_tokens": 3000, "reasoning": {"effort": EFFORT}})
    if "http" in r2: return {"call": c["name"], "args": c["arguments"], "round2": r2}
    return {"call": c["name"], "args": c["arguments"], "round1_kinds": kinds(r), "final": (out_text(r2) or "")[:100], "cached2": (r2.get("usage") or {}).get("input_tokens_details")}
check("tools", t_tools)

# 6 image
def t_image():
    b64 = base64.b64encode(png((255, 0, 0))).decode()
    r, dt = post("/responses", {"model": MODEL, "max_output_tokens": 3000, "reasoning": {"effort": EFFORT},
        "input": [{"role": "user", "content": [{"type": "input_text", "text": "What single color fills this image? One word."}, {"type": "input_image", "image_url": "data:image/png;base64," + b64}]}]})
    if "http" in r: return r
    return {"s": round(dt, 2), "text": (out_text(r) or "")[:60]}
check("image", t_image)

# 7 previous_response_id
def t_prev():
    r, _ = post("/responses", {"model": MODEL, "input": "Remember the word BANANA. Reply OK.", "max_output_tokens": 2000, "reasoning": {"effort": EFFORT}, "store": True})
    if "http" in r: return {"first": r}
    rid = r.get("id")
    r2, _ = post("/responses", {"model": MODEL, "previous_response_id": rid, "input": "What word did I ask you to remember?", "max_output_tokens": 2000, "reasoning": {"effort": EFFORT}})
    if "http" in r2: return {"id": rid, "second": r2}
    return {"id": rid, "text": (out_text(r2) or "")[:80]}
check("previous_response_id", t_prev)

# 8 multi-turn cache: same long prefix twice, compare cached tokens, chat vs responses
LONG = ("The quick brown fox jumps over the lazy dog. " * 700)
def t_cache():
    res = {}
    for api in ("responses", "chat"):
        runs = []
        for i in range(2):
            q = f"{LONG}\nQuestion {api}{i}: say the word OK."
            if api == "responses":
                r, dt = post("/responses", {"model": MODEL, "input": q, "max_output_tokens": 1500, "reasoning": {"effort": "minimal" if False else EFFORT}})
                u = (r.get("usage") or {}) if "http" not in r else r
                runs.append({"s": round(dt, 2), "in": u.get("input_tokens"), "cached": (u.get("input_tokens_details") or {}).get("cached_tokens")})
            else:
                r, dt = post("/chat/completions", {"model": MODEL, "messages": [{"role": "user", "content": q}], "max_tokens": 1500, "reasoning_effort": EFFORT})
                u = (r.get("usage") or {}) if "http" not in r else r
                runs.append({"s": round(dt, 2), "in": u.get("prompt_tokens"), "cached": (u.get("prompt_tokens_details") or {}).get("cached_tokens")})
        res[api] = runs
    return res
check("cache_prefix", t_cache)
print("DONE")
