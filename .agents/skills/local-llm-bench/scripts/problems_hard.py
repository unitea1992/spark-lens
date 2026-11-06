"""難しいコード問題 19 問（参照実装と同じ入力で採点する）。"""
import json, random, re, functools, heapq
rnd = random.Random(7)
def regex_match(s, p):
    @functools.lru_cache(None)
    def f(i, j):
        if j == len(p): return i == len(s)
        first = i < len(s) and p[j] in (s[i], '.')
        if j + 1 < len(p) and p[j+1] == '*': return f(i, j+2) or (first and f(i+1, j))
        return first and f(i+1, j+1)
    return f(0, 0)
def wildcard_match(s, p):
    @functools.lru_cache(None)
    def f(i, j):
        if j == len(p): return i == len(s)
        if p[j] == '*': return f(i, j+1) or (i < len(s) and f(i+1, j))
        return i < len(s) and p[j] in (s[i], '?') and f(i+1, j+1)
    return f(0, 0)
def min_window(s, t):
    from collections import Counter
    need = Counter(t); miss = len(t); best = ""; l = 0
    for r, ch in enumerate(s):
        if need[ch] > 0: miss -= 1
        need[ch] -= 1
        while miss == 0:
            if not best or r - l + 1 < len(best): best = s[l:r+1]
            need[s[l]] += 1
            if need[s[l]] > 0: miss += 1
            l += 1
    return best
def trap_rain_water(h):
    l, r, lm, rm, t = 0, len(h) - 1, 0, 0, 0
    while l < r:
        if h[l] < h[r]:
            lm = max(lm, h[l]); t += lm - h[l]; l += 1
        else:
            rm = max(rm, h[r]); t += rm - h[r]; r -= 1
    return t
def largest_rectangle(h):
    st = []; best = 0; h = h + [0]
    for i, x in enumerate(h):
        while st and h[st[-1]] >= x:
            H = h[st.pop()]; w = i if not st else i - st[-1] - 1; best = max(best, H * w)
        st.append(i)
    return best
def n_queens_count(n):
    def go(r, c, d1, d2):
        if r == n: return 1
        t = 0
        for x in range(n):
            if x in c or r - x in d1 or r + x in d2: continue
            t += go(r + 1, c | {x}, d1 | {r - x}, d2 | {r + x})
        return t
    return go(0, frozenset(), frozenset(), frozenset())
def median_two_sorted(a, b):
    m = sorted(a + b); n = len(m)
    return float(m[n // 2]) if n % 2 else (m[n // 2 - 1] + m[n // 2]) / 2
def count_inversions(nums):
    def sort(a):
        if len(a) <= 1: return a, 0
        mid = len(a) // 2; l, x = sort(a[:mid]); r, y = sort(a[mid:]); i = j = 0; out = []; c = x + y
        while i < len(l) and j < len(r):
            if l[i] <= r[j]: out.append(l[i]); i += 1
            else: out.append(r[j]); j += 1; c += len(l) - i
        return out + l[i:] + r[j:], c
    return sort(list(nums))[1]
def text_justify(words, width):
    res = []; i = 0
    while i < len(words):
        j = i; ln = 0
        while j < len(words) and ln + len(words[j]) + (j - i) <= width: ln += len(words[j]); j += 1
        gaps = j - i - 1
        if j == len(words) or gaps == 0:
            line = " ".join(words[i:j]); res.append(line + " " * (width - len(line)))
        else:
            sp, ex = divmod(width - ln, gaps); line = ""
            for k in range(i, j - 1): line += words[k] + " " * (sp + (1 if k - i < ex else 0))
            res.append(line + words[j - 1])
        i = j
    return res
def skyline(buildings):
    ev = sorted([(l, -h, r) for l, r, h in buildings] + [(r, 0, 0) for _, r, _ in buildings])
    res = []; heap = [(0, float('inf'))]
    for x, negh, r in ev:
        while heap[0][1] <= x: heapq.heappop(heap)
        if negh: heapq.heappush(heap, (negh, r))
        h = -heap[0][0]
        if not res or res[-1][1] != h: res.append([x, h])
    return res
def cheapest_flights(n, flights, src, dst, k):
    INF = float('inf'); d = [INF] * n; d[src] = 0
    for _ in range(k + 1):
        nd = d[:]
        for a, b, w in flights:
            if d[a] + w < nd[b]: nd[b] = d[a] + w
        d = nd
    return -1 if d[dst] == INF else d[dst]
def lfu_sim(capacity, ops):
    out = []; vals = {}; freq = {}; order = {}; tick = [0]
    for op in ops:
        tick[0] += 1
        if op[0] == "get":
            k = op[1]
            if k in vals: freq[k] += 1; order[k] = tick[0]; out.append(vals[k])
            else: out.append(-1)
        else:
            _, k, v = op
            if capacity == 0: continue
            if k in vals: vals[k] = v; freq[k] += 1; order[k] = tick[0]
            else:
                if len(vals) >= capacity:
                    ev = min(vals, key=lambda x: (freq[x], order[x])); del vals[ev]; del freq[ev]; del order[ev]
                vals[k] = v; freq[k] = 1; order[k] = tick[0]
    return out
def longest_valid_parentheses(s):
    st = [-1]; best = 0
    for i, c in enumerate(s):
        if c == '(': st.append(i)
        else:
            st.pop()
            if not st: st.append(i)
            else: best = max(best, i - st[-1])
    return best
def burst_balloons(nums):
    a = [1] + list(nums) + [1]; n = len(a)
    dp = [[0] * n for _ in range(n)]
    for ln in range(2, n):
        for i in range(n - ln):
            j = i + ln
            dp[i][j] = max(dp[i][k] + a[i] * a[k] * a[j] + dp[k][j] for k in range(i + 1, j))
    return dp[0][n - 1]
def alien_order(words):
    letters = sorted(set("".join(words))); adj = {c: set() for c in letters}; ind = {c: 0 for c in letters}
    for a, b in zip(words, words[1:]):
        for x, y in zip(a, b):
            if x != y:
                if y not in adj[x]: adj[x].add(y); ind[y] += 1
                break
        else:
            if len(a) > len(b): return ""
    h = [c for c in letters if ind[c] == 0]; heapq.heapify(h); out = []
    while h:
        c = heapq.heappop(h); out.append(c)
        for y in adj[c]:
            ind[y] -= 1
            if ind[y] == 0: heapq.heappush(h, y)
    return "".join(out) if len(out) == len(letters) else ""
def sudoku_valid(board):
    seen = set()
    for i in range(9):
        for j in range(9):
            v = board[i][j]
            if v == '.': continue
            for key in (('r', i, v), ('c', j, v), ('b', i // 3, j // 3, v)):
                if key in seen: return False
                seen.add(key)
    return True
def shortest_bridge(grid):
    from collections import deque
    n = len(grid); g = [r[:] for r in grid]; q = deque(); start = None
    for i in range(n):
        for j in range(n):
            if g[i][j] == 1: start = (i, j); break
        if start: break
    st = [start]; g[start[0]][start[1]] = 2
    while st:
        x, y = st.pop(); q.append((x, y, 0))
        for a, b in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
            if 0 <= a < n and 0 <= b < n and g[a][b] == 1: g[a][b] = 2; st.append((a, b))
    seen = {(x, y) for x, y, _ in q}
    while q:
        x, y, d = q.popleft()
        for a, b in ((x+1,y),(x-1,y),(x,y+1),(x,y-1)):
            if 0 <= a < n and 0 <= b < n and (a, b) not in seen:
                if g[a][b] == 1: return d
                seen.add((a, b)); q.append((a, b, d + 1))
    return -1
def max_profit_k(k, prices):
    if not prices or k == 0: return 0
    if k >= len(prices) // 2: return sum(max(0, b - a) for a, b in zip(prices, prices[1:]))
    buy = [float('-inf')] * (k + 1); sell = [0] * (k + 1)
    for p in prices:
        for j in range(1, k + 1):
            buy[j] = max(buy[j], sell[j-1] - p); sell[j] = max(sell[j], buy[j] + p)
    return sell[k]
def distinct_subsequences(s, t):
    dp = [1] + [0] * len(t)
    for c in s:
        for j in range(len(t), 0, -1):
            if t[j-1] == c: dp[j] += dp[j-1]
    return dp[len(t)]
def ri(a, b): return rnd.randint(a, b)
def rs(alpha, a, b): return "".join(rnd.choice(alpha) for _ in range(ri(a, b)))
P = []
def add(fn, sig, desc, inputs): P.append((fn.__name__, sig, desc, fn, inputs))
add(regex_match, "regex_match(s, p)", "Return True if the whole string s matches pattern p, where '.' matches any single character and '*' matches zero or more of the preceding element (full match, not substring).", [("aa","a"),("aa","a*"),("ab",".*"),("aab","c*a*b"),("mississippi","mis*is*p*."),("",""),("","a*"),("a","ab*")] + [(rs("ab",0,6), "".join(rnd.choice(["a","b",".","a*","b*",".*"]) for _ in range(ri(0,4)))) for _ in range(6)])
add(wildcard_match, "wildcard_match(s, p)", "Return True if the whole string s matches pattern p where '?' matches any single character and '*' matches any sequence (including empty).", [("aa","a"),("aa","*"),("cb","?a"),("adceb","*a*b"),("acdcb","a*c?b"),("",""),("","*"),("abc","a**c")] + [(rs("ab",0,6), "".join(rnd.choice("ab?*") for _ in range(ri(0,5)))) for _ in range(6)])
add(min_window, "min_window(s, t)", "Return the shortest substring of s containing every character of t with multiplicity; the leftmost such substring on ties; '' if none.", [("ADOBECODEBANC","ABC"),("a","a"),("a","aa"),("ab","b"),("aaflslflsldkalskaaa","aaa")] + [(rs("abc",1,12), rs("abc",1,4)) for _ in range(6)])
add(trap_rain_water, "trap_rain_water(height)", "Given non-negative integer bar heights of width 1, return the total units of rain water trapped.", [([0,1,0,2,1,0,1,3,2,1,2,1],),([4,2,0,3,2,5],),([],),([3],)] + [([ri(0,6) for _ in range(ri(0,12))],) for _ in range(5)])
add(largest_rectangle, "largest_rectangle(heights)", "Area of the largest rectangle in a histogram of non-negative integer bar heights (width 1).", [([2,1,5,6,2,3],),([2,4],),([],),([5],)] + [([ri(0,8) for _ in range(ri(1,12))],) for _ in range(6)])
add(n_queens_count, "n_queens_count(n)", "Number of distinct solutions to the n-queens puzzle (n >= 1).", [(1,),(2,),(4,),(5,),(6,),(8,)])
add(median_two_sorted, "median_two_sorted(a, b)", "Median of the union of two sorted lists of numbers as a float (at least one list is non-empty).", [([1,3],[2]),([1,2],[3,4]),([],[1]),([0,0],[0,0]),([2],[])] + [(sorted(ri(-9,9) for _ in range(ri(0,6))), sorted(ri(-9,9) for _ in range(ri(1,6)))) for _ in range(5)])
add(count_inversions, "count_inversions(nums)", "Number of pairs (i, j) with i < j and nums[i] > nums[j].", [([2,4,1,3,5],),([5,4,3,2,1],),([],),([1,1,1],)] + [([ri(0,9) for _ in range(ri(0,20))],) for _ in range(6)])
add(text_justify, "text_justify(words, width)", "Fully justify text into lines of exactly width characters: pack as many words per line as fit, distribute extra spaces between words as evenly as possible with extra spaces on the left gaps, the last line and single-word lines are left-justified padded with trailing spaces. Return the list of lines.", [(["This","is","an","example","of","text","justification."],16),(["What","must","be","acknowledgment","shall","be"],16),(["Science","is","what","we","understand","well","enough","to","explain","to","a","computer.","Art","is","everything","else","we","do"],20),(["a"],3)])
add(skyline, "skyline(buildings)", "buildings are [left, right, height]. Return the skyline key points [[x, height], ...] sorted by x, where each point is the left end of a horizontal segment and the last point has height 0; consecutive points never share a height.", [([[2,9,10],[3,7,15],[5,12,12],[15,20,10],[19,24,8]],),([[0,2,3],[2,5,3]],),([[1,2,1],[1,2,2],[1,2,3]],),([],)] + [([[a, a + ri(1,5), ri(1,6)] for a in [ri(0,10) for _ in range(ri(1,5))]],) for _ in range(5)])
add(cheapest_flights, "cheapest_flights(n, flights, src, dst, k)", "flights are [from, to, price] directed edges over cities 0..n-1. Return the cheapest price from src to dst using at most k stops (k intermediate cities), or -1 if impossible.", [(4,[[0,1,100],[1,2,100],[2,0,100],[1,3,600],[2,3,200]],0,3,1),(3,[[0,1,100],[1,2,100],[0,2,500]],0,2,1),(3,[[0,1,100],[1,2,100],[0,2,500]],0,2,0),(2,[],0,1,3)] + [(5,[[ri(0,4),ri(0,4),ri(1,9)] for _ in range(ri(3,9))],0,4,ri(0,3)) for _ in range(6)])
add(lfu_sim, "lfu_sim(capacity, ops)", "Simulate an LFU cache. ops is a list of ('put', key, value) or ('get', key). get returns the value or -1 and counts as a use; put of an existing key updates it and counts as a use; put of a new key when full first evicts the least frequently used key, breaking ties by least recently used; a new key starts with frequency 1. capacity 0 stores nothing. Return the list of results of the get operations in order.", [(2,[("put",1,1),("put",2,2),("get",1),("put",3,3),("get",2),("get",3),("put",4,4),("get",1),("get",3),("get",4)]),(0,[("put",1,1),("get",1)]),(1,[("put",1,1),("put",2,2),("get",1),("get",2)])] + [(ri(1,3), [(rnd.choice(["put","get"]), ri(1,4), ri(0,9)) if rnd.random() < 0.5 else ("get", ri(1,4)) for _ in range(ri(6,16))]) for _ in range(6)])
P[-1] = (P[-1][0], P[-1][1], P[-1][2], P[-1][3], [(c, [tuple(o[:3]) if o[0] == "put" else ("get", o[1]) for o in ops]) for c, ops in P[-1][4]])
add(longest_valid_parentheses, "longest_valid_parentheses(s)", "Length of the longest contiguous substring of '(' and ')' that is a valid balanced parentheses string.", [("(()",),(")()())",),("",),("()(()",),("(()())",)] + [(rs("()",0,14),) for _ in range(6)])
add(burst_balloons, "burst_balloons(nums)", "Burst balloons: bursting balloon i gives nums[left]*nums[i]*nums[right] coins where left/right are the nearest unburst neighbours (a missing neighbour counts as 1). Return the maximum coins from bursting all balloons.", [([3,1,5,8],),([1,5],),([],),([7],)] + [([ri(0,6) for _ in range(ri(1,7))],) for _ in range(5)])
add(alien_order, "alien_order(words)", "words are sorted in an unknown alien alphabet's lexicographic order. Return a string of all distinct letters in an order consistent with that, choosing the alphabetically smallest letter whenever several are possible (smallest topological order); return '' if the ordering is inconsistent (cycle, or a longer word before its own prefix).", [(["wrt","wrf","er","ett","rftt"],),(["z","x"],),(["z","x","z"],),(["abc","ab"],),(["a"],),([],)] + [(["".join(rnd.choice("abcd") for _ in range(ri(1,3))) for _ in range(ri(2,5))],) for _ in range(5)])
b1 = [["5","3",".",".","7",".",".",".","."],["6",".",".","1","9","5",".",".","."],[".","9","8",".",".",".",".","6","."],["8",".",".",".","6",".",".",".","3"],["4",".",".","8",".","3",".",".","1"],["7",".",".",".","2",".",".",".","6"],[".","6",".",".",".",".","2","8","."],[".",".",".","4","1","9",".",".","5"],[".",".",".",".","8",".",".","7","9"]]
b2 = [r[:] for r in b1]; b2[0][0] = "8"
b3 = [r[:] for r in b1]; b3[1][1] = "5"
b4 = [r[:] for r in b1]; b4[3][3] = "9"
add(sudoku_valid, "sudoku_valid(board)", "board is a 9x9 list of lists of single-character strings: digits '1'-'9' or '.' for empty. Return True if the filled cells have no repeated digit in any row, column or 3x3 box (it need not be solvable).", [(b1,),(b2,),(b3,),(b4,)])
add(shortest_bridge, "shortest_bridge(grid)", "grid is an n x n list of lists of 0/1 containing exactly two 4-directionally connected islands of 1s. Return the minimum number of 0 cells to flip to 1 to connect the two islands.", [([[0,1],[1,0]],),([[0,1,0],[0,0,0],[0,0,1]],),([[1,1,1,1,1],[1,0,0,0,1],[1,0,1,0,1],[1,0,0,0,1],[1,1,1,1,1]],)])
add(max_profit_k, "max_profit_k(k, prices)", "Maximum profit from at most k buy-sell transactions (one share at a time; must sell before buying again) on the given daily prices.", [(2,[2,4,1]),(2,[3,2,6,5,0,3]),(0,[1,2,3]),(1,[]),(100,[1,2,3,4,5])] + [(ri(1,3),[ri(0,9) for _ in range(ri(0,10))]) for _ in range(6)])
add(distinct_subsequences, "distinct_subsequences(s, t)", "Number of distinct subsequences of s that equal t (index choices count separately).", [("rabbbit","rabbit"),("babgbag","bag"),("",""),("abc",""),("a","aa")] + [(rs("ab",0,10), rs("ab",0,4)) for _ in range(6)])
