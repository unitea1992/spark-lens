"""標準のコード問題 20 問（参照実装と同じ入力で採点する）。"""
import json, random, re, functools, heapq
rnd = random.Random(7)
def merge_intervals(iv):
    out = []
    for s, e in sorted(iv):
        if out and s <= out[-1][1]: out[-1][1] = max(out[-1][1], e)
        else: out.append([s, e])
    return out
def roman_to_int(s):
    v = {'I':1,'V':5,'X':10,'L':50,'C':100,'D':500,'M':1000}; t = 0
    for i, c in enumerate(s):
        t += -v[c] if i + 1 < len(s) and v[c] < v[s[i+1]] else v[c]
    return t
def longest_common_prefix(strs):
    if not strs: return ""
    p = strs[0]
    for s in strs[1:]:
        while not s.startswith(p): p = p[:-1]
    return p
def num_islands(g):
    g = [list(r) for r in g]; n = 0
    for i in range(len(g)):
        for j in range(len(g[0]) if g else 0):
            if g[i][j] == '1':
                n += 1; st = [(i, j)]; g[i][j] = '0'
                while st:
                    x, y = st.pop()
                    for a, b in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
                        if 0 <= a < len(g) and 0 <= b < len(g[0]) and g[a][b] == '1': g[a][b] = '0'; st.append((a, b))
    return n
def eval_expr(s):
    toks = re.findall(r'\d+|[-+*/()]', s); pos = [0]
    def peek(): return toks[pos[0]] if pos[0] < len(toks) else None
    def nxt(): pos[0] += 1; return toks[pos[0]-1]
    def expr():
        v = term()
        while peek() in ('+', '-'):
            o = nxt(); r = term(); v = v + r if o == '+' else v - r
        return v
    def term():
        v = fac()
        while peek() in ('*', '/'):
            o = nxt(); r = fac()
            v = v * r if o == '*' else int(v / r)
        return v
    def fac():
        t = nxt()
        if t == '-': return -fac()
        if t == '(': v = expr(); nxt(); return v
        return int(t)
    return expr()
def top_k_frequent(nums, k):
    from collections import Counter
    c = Counter(nums); return sorted(c, key=lambda x: (-c[x], x))[:k]
def lru_hits(cap, acc):
    from collections import OrderedDict
    d = OrderedDict(); h = 0
    for a in acc:
        if a in d: h += 1; d.move_to_end(a)
        else:
            d[a] = 1
            if len(d) > cap: d.popitem(last=False)
    return h
def topo_order(n, edges):
    import heapq
    ind = [0]*n; adj = [[] for _ in range(n)]
    for a, b in edges: adj[a].append(b); ind[b] += 1
    h = [i for i in range(n) if ind[i] == 0]; heapq.heapify(h); out = []
    while h:
        x = heapq.heappop(h); out.append(x)
        for y in adj[x]:
            ind[y] -= 1
            if ind[y] == 0: heapq.heappush(h, y)
    return out if len(out) == n else []
def min_coins(coins, amount):
    INF = 10**9; dp = [0] + [INF]*amount
    for a in range(1, amount+1):
        for c in coins:
            if c <= a: dp[a] = min(dp[a], dp[a-c]+1)
    return -1 if dp[amount] >= INF else dp[amount]
def decode_string(s):
    st = [("", 1)]; cur = ""; num = 0
    for ch in s:
        if ch.isdigit(): num = num*10 + int(ch)
        elif ch == '[': st.append((cur, num)); cur = ""; num = 0
        elif ch == ']': p, k = st.pop(); cur = p + cur*k
        else: cur += ch
    return cur
def valid_brackets(s):
    st = []; m = {')':'(',']':'[','}':'{'}
    for c in s:
        if c in '([{': st.append(c)
        elif not st or st.pop() != m[c]: return False
    return not st
def word_break_count(s, words):
    w = set(words); dp = [1] + [0]*len(s)
    for i in range(1, len(s)+1):
        for j in range(i):
            if dp[j] and s[j:i] in w: dp[i] += dp[j]
    return dp[len(s)]
def rotate_matrix(m): return [list(r) for r in zip(*m[::-1])]
def max_subarray_product(nums):
    mx = mn = best = nums[0]
    for x in nums[1:]:
        c = (x, mx*x, mn*x); mx, mn = max(c), min(c); best = max(best, mx)
    return best
def edit_distance(a, b):
    dp = list(range(len(b)+1))
    for i in range(1, len(a)+1):
        prev, dp[0] = dp[0], i
        for j in range(1, len(b)+1):
            cur = dp[j]; dp[j] = min(dp[j]+1, dp[j-1]+1, prev + (a[i-1] != b[j-1])); prev = cur
    return dp[len(b)]
def days_between(y1, m1, d1, y2, m2, d2):
    import datetime; return (datetime.date(y2, m2, d2) - datetime.date(y1, m1, d1)).days
def spiral_order(m):
    out = []
    while m:
        out += m.pop(0); m = [list(r) for r in zip(*m)][::-1]
    return out
def permutations_unique(nums):
    from itertools import permutations
    return sorted(set(permutations(nums)))
def parse_csv_line(s):
    out, cur, q, i = [], "", False, 0
    while i < len(s):
        c = s[i]
        if q:
            if c == '"' and i+1 < len(s) and s[i+1] == '"': cur += '"'; i += 1
            elif c == '"': q = False
            else: cur += c
        elif c == '"': q = True
        elif c == ',': out.append(cur); cur = ""
        else: cur += c
        i += 1
    out.append(cur); return out
def next_greater(nums):
    out = [-1]*len(nums); st = []
    for i, x in enumerate(nums):
        while st and nums[st[-1]] < x: out[st.pop()] = x
        st.append(i)
    return out
def ri(a, b): return rnd.randint(a, b)
P = []
def add(fn, sig, desc, inputs): P.append((fn.__name__, sig, desc, fn, inputs))
add(merge_intervals, "merge_intervals(intervals)", "Merge overlapping intervals (intervals that touch, e.g. [1,3] and [3,5], are merged). Input: list of [start,end] lists in any order. Return a list of [start,end] lists sorted by start.",
    [([[1,3],[2,6],[8,10],[15,18]],), ([[1,4],[4,5]],), ([],), ([[5,5]],)] + [([[ri(0,30), 0] for _ in range(ri(1,8))],) for _ in range(5)])
P[-1] = (P[-1][0], P[-1][1], P[-1][2], P[-1][3], [([[a, a+ri(0,6)] for a in [ri(0,30) for _ in range(ri(1,9))]],) for _ in range(6)] + P[-1][4][:4])
add(roman_to_int, "roman_to_int(s)", "Convert a valid Roman numeral string (1..3999) to an integer.", [("III",),("LVIII",),("MCMXCIV",),("IV",),("MMMCMXCIX",),("XLII",)])
add(longest_common_prefix, "longest_common_prefix(strs)", "Return the longest common prefix of a list of strings ('' if none or the list is empty).", [(["flower","flow","flight"],),(["dog","racecar"],),([],),(["a"],),(["abc","abc","abc"],),(["","b"],)])
add(num_islands, "num_islands(grid)", "grid is a list of strings of '1' (land) and '0' (water). Count 4-directionally connected land components. Empty grid gives 0.", [(["11000","11000","00100","00011"],),([],),(["1"],),(["101","010","101"],)] + [(["".join(rnd.choice("10") for _ in range(6)) for _ in range(5)],) for _ in range(4)])
add(eval_expr, "eval_expr(s)", "Evaluate an arithmetic expression string with non-negative integers, + - * /, parentheses, spaces and unary minus. Division truncates toward zero. Standard precedence.", [("1 + 2 * 3",),("(1+2)*3",),("-(2+3)*4",),("7 / -2",),("-7 / 2",),("2*(3+(4-1))/3",),("10-2-3",),(" 100 / 10 / 5 ",)])
add(top_k_frequent, "top_k_frequent(nums, k)", "Return the k most frequent values, ordered by frequency descending, ties broken by smaller value first.", [([1,1,1,2,2,3],2),([1],1),([4,4,5,5,6],3)] + [([ri(0,6) for _ in range(ri(5,15))], ri(1,3)) for _ in range(4)])
add(lru_hits, "lru_hits(capacity, accesses)", "Simulate an LRU cache of the given capacity over a list of keys; return the number of accesses that were hits (a hit refreshes recency).", [(2,[1,2,1,3,2,1]),(1,[1,1,1]),(3,[1,2,3,4,1,2,5,1,2,3,4,5])] + [(ri(1,4),[ri(0,6) for _ in range(ri(5,20))]) for _ in range(4)])
add(topo_order, "topo_order(n, edges)", "Nodes 0..n-1, edges are (a,b) meaning a before b. Return the lexicographically smallest topological order as a list, or [] if there is a cycle.", [(4,[(0,1),(0,2),(1,3),(2,3)]),(3,[(0,1),(1,2),(2,0)]),(5,[]),(5,[(4,0),(3,1)])] + [(6,[(a,b) for a,b in [(ri(0,5),ri(0,5)) for _ in range(5)] if a < b]) for _ in range(4)])
add(min_coins, "min_coins(coins, amount)", "Fewest coins (unlimited supply) summing to amount; -1 if impossible; 0 for amount 0.", [([1,2,5],11),([2],3),([1],0),([186,419,83,408],6249),([3,7],11)] + [([ri(2,9) for _ in range(ri(1,3))], ri(0,60)) for _ in range(4)])
add(decode_string, "decode_string(s)", "Decode strings like '3[a2[c]]' -> 'accaccacc'. Digits (possibly multi-digit) followed by [ ] repeat the bracketed content; nesting allowed; other characters are literal.", [("3[a]2[bc]",),("3[a2[c]]",),("2[abc]3[cd]ef",),("abc",),("10[x]",),("",),("2[2[2[a]]]b",)])
add(valid_brackets, "valid_brackets(s)", "Return True if the string of ()[]{} characters is balanced and correctly nested (empty string is valid).", [("()",),("()[]{}",),("(]",),("([)]",),("{[]}",),("",),("(((",),("]",)])
add(word_break_count, "word_break_count(s, words)", "Count the number of distinct ways to split s into a sequence of words from the list (words may repeat). Empty s has 1 way.", [("catsanddog",["cat","cats","and","sand","dog"]),("aaaa",["a","aa"]),("abc",["d"]),("",["a"]),("pineapplepenapple",["apple","pen","applepen","pine","pineapple"])])
add(rotate_matrix, "rotate_matrix(m)", "Rotate a rectangular matrix (list of lists) 90 degrees clockwise and return a new matrix.", [([[1,2,3],[4,5,6]],),([[1]],),([[1,2],[3,4]],),([[1,2,3,4]],)] + [([[ri(0,9) for _ in range(3)] for _ in range(ri(1,4))],) for _ in range(3)])
add(max_subarray_product, "max_subarray_product(nums)", "Maximum product of a non-empty contiguous subarray of integers.", [([2,3,-2,4],),([-2,0,-1],),([-2],),([-2,3,-4],),([0,2],)] + [([ri(-4,4) for _ in range(ri(1,9))],) for _ in range(4)])
add(edit_distance, "edit_distance(a, b)", "Levenshtein distance (insert, delete, substitute each cost 1) between strings a and b.", [("horse","ros"),("intention","execution"),("",""),("a",""),("kitten","sitting")] + [("".join(rnd.choice("abc") for _ in range(ri(0,7))), "".join(rnd.choice("abc") for _ in range(ri(0,7)))) for _ in range(4)])
add(days_between, "days_between(y1, m1, d1, y2, m2, d2)", "Number of days from the first date to the second (second minus first, may be negative) in the Gregorian calendar.", [(2020,2,28,2020,3,1),(2000,1,1,2000,1,1),(1999,12,31,2000,1,1),(2024,3,1,2023,3,1),(1900,2,28,1900,3,1)])
add(spiral_order, "spiral_order(matrix)", "Return the elements of a rectangular matrix in clockwise spiral order starting at the top-left. Do not modify the input.", [([[1,2,3],[4,5,6],[7,8,9]],),([[1,2,3,4]],),([[1],[2],[3]],),([[1,2],[3,4],[5,6]],)])
add(permutations_unique, "permutations_unique(nums)", "Return all distinct permutations of nums (which may contain duplicates) as a list of lists in lexicographic order.", [([1,1,2],),([1,2,3],),([1],),([2,2,2],)])
P[-1] = (P[-1][0], P[-1][1], P[-1][2], lambda nums: [list(t) for t in permutations_unique(nums)], P[-1][4])
add(parse_csv_line, "parse_csv_line(s)", 'Parse one CSV line into a list of strings. Fields are comma separated; a field may be wrapped in double quotes, in which case it may contain commas and a doubled double-quote ("") means one literal quote. No stripping of spaces.', [("a,b,c",),('"a,b",c',),('"he said ""hi""",x',),("",),(",,",),('a," b ",c',)])
add(next_greater, "next_greater(nums)", "For each element, the next greater element to its right, or -1 if none. Return a list.", [([2,1,2,4,3],),([1,2,3],),([3,2,1],),([],)] + [([ri(0,9) for _ in range(ri(1,9))],) for _ in range(3)])
