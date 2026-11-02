import json,random,sys,time,urllib.request
BASE,MODEL,EFF=sys.argv[1],sys.argv[2],sys.argv[3]
def post(p,b):
    r=urllib.request.Request(BASE+p,json.dumps(b).encode(),{"Content-Type":"application/json"})
    t=time.time(); d=json.loads(urllib.request.urlopen(r,timeout=900).read()); return d,time.time()-t
# Random words, not one repeated sentence: Qwen dual does not keep a prompt made of a repeated sentence for reuse
# (cached 0 every time), which looks like a cache fault but is only the test text.
_W="amber basket candle dune ember fjord glacier harbor island jungle kettle lantern meadow nectar orchard pebble quarry river summit timber valley willow".split()
_r=random.Random(7)
SYS="You are a coding agent. "+" ".join(" ".join(_r.choice(_W) for _ in range(8))+"." for _ in range(400))
TOOLS_R=[{"type":"function","name":"get_weather","description":"weather","parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}}]
TOOLS_C=[{"type":"function","function":{k:v for k,v in TOOLS_R[0].items() if k!="type"}}]
# responses: 3 rounds, each appends output items
inp=[{"role":"system","content":SYS},{"role":"user","content":"Check weather in Tokyo, then Osaka, then Kyoto, one tool call at a time, then summarize."}]
print("RESPONSES")
for i in range(4):
    r,dt=post("/responses",{"model":MODEL,"input":inp,"tools":TOOLS_R,"max_output_tokens":3000,"reasoning":{"effort":EFF}})
    u=r["usage"];print(i,round(dt,2),"in",u["input_tokens"],"cached",u["input_tokens_details"]["cached_tokens"],[o["type"] for o in r["output"]])
    inp+=r["output"]; calls=[o for o in r["output"] if o["type"]=="function_call"]
    if not calls:break
    for c in calls: inp.append({"type":"function_call_output","call_id":c["call_id"],"output":"Sunny, 21C"})
print("CHAT")
msgs=[{"role":"system","content":SYS+" "},{"role":"user","content":"Check weather in Tokyo, then Osaka, then Kyoto, one tool call at a time, then summarize."}]
for i in range(4):
    r,dt=post("/chat/completions",{"model":MODEL,"messages":msgs,"tools":TOOLS_C,"max_tokens":3000,"reasoning_effort":EFF})
    u=r["usage"];m=r["choices"][0]["message"];print(i,round(dt,2),"in",u["prompt_tokens"],"cached",u["prompt_tokens_details"]["cached_tokens"],"tool_calls" if m.get("tool_calls") else "text")
    msgs.append(m)
    if not m.get("tool_calls"):break
    for c in m["tool_calls"]: msgs.append({"role":"tool","tool_call_id":c["id"],"content":"Sunny, 21C"})
