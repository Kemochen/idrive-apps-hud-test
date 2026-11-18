#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 minakoto
"""Bakes the HUD turn card's icons into src/card_icons.cpp.

    python3 tools/bake_card_icons.py --maneuvers Maneuvers.pcvd --lanes Lanes.pcvd > src/card_icons.cpp
    python3 tools/bake_card_icons.py --maneuvers ... --lanes ... --svg out/   # each icon as an SVG, to look at

The turn arrows and the lanes are Mapbox's navigation icons, read from the
PaintCode documents of mapbox/navigation-ui-resources (CC0 1.0, public
domain; see icons/README.md for the commit and the files' hashes). The
three-way forks and the lane changes are OsmAnd's, the overpass, the ferry
and the car train Material Symbols, the underpass Maki's: SVGs in icons/.

Each icon is a list of paths, each filled or stroked in the card's white
(Mapbox's primary colour) or its grey (the secondary), in a square box of
units: Mapbox's 32 (turns) and 30 (lanes); the SVG icons are fitted into a
32 box as the review page showed them. A path is its commands as numbers:
0 x y (move), 1 x y (line), 2 x1 y1 x2 y2 x y (curve), 3 (close).

The turn arrows' heads are drawn smaller than Mapbox's (HEAD_SCALE): the
head moves towards its tip, the stem keeps its width. The roundabout is
baked every ROUNDABOUT_STEP degrees of Mapbox's roundabout_angle.

Only the Python standard library is needed.
"""
import argparse
import math
import os
import plistlib
import re
import sys

HEAD_SCALE = 0.6
ROUNDABOUT_STEP = 5
ROUNDABOUT_MIN, ROUNDABOUT_MAX = 20, 340
ICONS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'icons')

# Mapbox's canvases the card draws, by the name the render looks them up by.
MANEUVERS = {
    'arrow_straight': 'arrow straight', 'arrow_slight_right': 'arrow slight right', 'arrow_right': 'arrow right',
    'arrow_sharp_right': 'arrow sharp right', 'arrow_uturn_right': 'arrow 180 right', 'offramp': 'offramp',
    'merge': 'merge', 'arrive': 'arrive', 'arrive_right': 'arrive right', 'destination': 'destination',
}
# The other icons: file, fitted how (a viewBox scale: the drawing's share of the box).
SVGS = {
    'fork3_left': ('osmand_3way_take_left.svg', 1.0), 'fork3_straight': ('osmand_3way_take_straight.svg', 1.0),
    'fork3_right': ('osmand_3way_take_right.svg', 1.0), 'lane_change_left': ('osmand_keep_left.svg', 1.0),
    'lane_change_right': ('osmand_keep_right.svg', 1.0), 'overpass': ('material_flyover.svg', 0.92),
    'underpass': ('maki_tunnel.svg', 0.8), 'ferry': ('material_directions_boat.svg', 0.75),
    'car_train': ('material_train.svg', 0.75),
}

# ---- affine matrices: (a, b, c, d, e, f), x' = a x + c y + e, y' = b x + d y + f ----


def mul(m, n):
    return (m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3],
            m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5])


def apply(m, p):
    return (m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5])


def node_matrix(ax, ay, rot_deg, sx, sy):
    """A node's local coordinates in its parent's: anchor + R(rotation) S(scale) p (y up, counterclockwise)."""
    r = math.radians(rot_deg)
    c, s = math.cos(r), math.sin(r)
    return (c * sx, s * sx, -s * sy, c * sy, ax, ay)


# ---- paths: a list of contours, each [closed, [(x, y)], [segment]], a segment ('L', p) or ('C', c1, c2, p) ----

def path_transform(contours, m):
    out = []
    for closed, start, segs in contours:
        out.append([closed, apply(m, start),
                    [(s[0],) + tuple(apply(m, q) for q in s[1:]) for s in segs]])
    return out


def path_numbers(contours):
    nums = []
    for closed, start, segs in contours:
        nums += [0, start[0], start[1]]
        for s in segs:
            if s[0] == 'L':
                nums += [1, s[1][0], s[1][1]]
            else:
                nums += [2, s[1][0], s[1][1], s[2][0], s[2][1], s[3][0], s[3][1]]
        if closed:
            nums.append(3)
    return nums


def bezier_point(p0, c1, c2, p1, t):
    u = 1 - t
    return (u * u * u * p0[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * p1[0],
            u * u * u * p0[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * p1[1])


def split_cubic(p0, c1, c2, p1, t):
    """The curve's first part up to t: (c1, c2, end)."""
    lerp = lambda a, b: (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    a, b, c = lerp(p0, c1), lerp(c1, c2), lerp(c2, p1)
    d, e = lerp(a, b), lerp(b, c)
    return a, d, lerp(d, e)


def truncated(contours, length):
    """The path's first `length` units (a dash of `length` and a gap longer than the path)."""
    out = []
    left = length
    for closed, start, segs in contours:
        segs = list(segs) + ([('L', start)] if closed else [])
        kept, at = [], start
        for s in segs:
            if left <= 0:
                break
            if s[0] == 'L':
                n = math.dist(at, s[1])
                if n <= left:
                    kept.append(s)
                    left -= n
                else:
                    t = left / n
                    kept.append(('L', (at[0] + (s[1][0] - at[0]) * t, at[1] + (s[1][1] - at[1]) * t)))
                    left = 0
            else:
                pts = [bezier_point(at, s[1], s[2], s[3], i / 64) for i in range(65)]
                lens = [math.dist(pts[i], pts[i + 1]) for i in range(64)]
                if sum(lens) <= left:
                    kept.append(s)
                    left -= sum(lens)
                else:
                    acc, i = 0, 0
                    while acc + lens[i] < left:
                        acc += lens[i]
                        i += 1
                    t = (i + (left - acc) / lens[i]) / 64
                    kept.append(('C',) + split_cubic(at, s[1], s[2], s[3], t))
                    left = 0
            at = s[-1]
        if kept:
            out.append([False, start, kept])
    return out


# ---- the heads: port of the review page's head shrink ----

def head_tips(start, segs, closed):
    verts = [(start, 'L' if closed else 'M')] + [(s[-1], s[0]) for s in segs]
    if closed and math.dist(verts[-1][0], start) < 1e-6:
        verts = verts[:-1]
        verts[0] = (start, segs[-1][0])
    n, res = len(verts), []
    for i in range(n):
        if not closed and (i == 0 or i == n - 1):
            continue
        prev, nxt = verts[(i - 1) % n], verts[(i + 1) % n]
        if verts[i][1] != 'L' or nxt[1] != 'L':
            continue
        t = verts[i][0]
        a = (prev[0][0] - t[0], prev[0][1] - t[1])
        b = (nxt[0][0] - t[0], nxt[0][1] - t[1])
        la, lb = math.hypot(*a), math.hypot(*b)
        if la < 3 or lb < 3:
            continue
        ang = math.degrees(math.acos(max(-1, min(1, (a[0] * b[0] + a[1] * b[1]) / la / lb))))
        if ang > 85 or ang < 40:
            continue
        d = (-(a[0] / la + b[0] / lb), -(a[1] / la + b[1] / lb))
        ld = math.hypot(*d)
        d = (d[0] / ld, d[1] / ld)
        nrm = (-d[1], d[0])

        def uv(q, t=t, d=d, nrm=nrm):
            return ((q[0] - t[0]) * d[0] + (q[1] - t[1]) * d[1], (q[0] - t[0]) * nrm[0] + (q[1] - t[1]) * nrm[1])
        length = max(-uv(prev[0])[0], -uv(nxt[0])[0])
        half = max(abs(uv(prev[0])[1]), abs(uv(nxt[0])[1]))
        res.append((t, d, nrm, uv, length, half))
    return res


def shrink_heads(contours, k):
    out = []
    for closed, start, segs in contours:
        for t, d, nrm, uv, length, half_head in head_tips(start, segs, closed):
            def zone(q):
                u, w = uv(q)
                return -(length + 1) <= u <= 0.01 and abs(w) <= half_head + 1
            pts = [start] + [q for s in segs for q in s[1:]]
            ws = [abs(uv(q)[1]) for q in pts if zone(q) and uv(q)[0] < -1 and abs(uv(q)[1]) > 0.3]
            half = min(ws)

            def moved(q):
                if not zone(q):
                    return q
                u, w = uv(q)
                w2 = w if abs(w) <= half else math.copysign(half + k * (abs(w) - half), w)
                return (t[0] + k * u * d[0] + w2 * nrm[0], t[1] + k * u * d[1] + w2 * nrm[1])
            start = moved(start)
            segs = [(s[0],) + tuple(moved(q) for q in s[1:]) for s in segs]
        out.append([closed, start, segs])
    return out


# ---- PaintCode documents ----

class Doc:
    def __init__(self, path):
        with open(path, 'rb') as f:
            self.objs = plistlib.load(f)['$objects']

    def r(self, v):
        return self.objs[v.data] if isinstance(v, plistlib.UID) else v

    def cls(self, o):
        return self.objs[o['$class'].data]['$classname'] if isinstance(o, dict) and '$class' in o else None

    def canvases(self):
        return {self.r(o['name']): o for o in self.objs if self.cls(o) == 'PPCanvas'}

    def items(self, o):
        return [self.r(x) for x in self.r(o['NS.objects'])] if isinstance(o, dict) else []

    def expressions(self, o):
        p = self.r(o.get('propertyValueProviders')) if 'propertyValueProviders' in o else None
        if not isinstance(p, dict):
            return {}
        out = {}
        for k, v in zip(self.items_raw(p, 'NS.keys'), self.items_raw(p, 'NS.objects')):
            v = self.r(v)
            if self.cls(v) == 'PPValueProviderExpression':
                out[self.r(k)] = (self.r(v['expression']), float(self.r(v['value'])))
        return out

    def items_raw(self, o, key):
        return [x for x in o.get(key, [])]

    def variables(self):
        """Each variable's expression (or None: an input)."""
        out = {}
        for o in self.objs:
            if self.cls(o) == 'PPVariable':
                vp = self.r(o.get('valueProvider')) if 'valueProvider' in o else None
                expr = self.r(vp['expression']) if self.cls(vp) == 'PPValueProviderExpression' else None
                out[self.r(o['name'])] = expr
        return out


def evaluate(expr, env):
    """A PaintCode expression: arithmetic, min/max, sin/cos of degrees, PI, a ? b : c."""
    e = expr.strip().replace('size.width', 'size_width').replace('size.height', 'size_height')
    m = re.match(r'^(.*?)\s*\?\s*(.*?)\s*:\s*(.*)$', e)
    if m:
        return evaluate(m.group(2), env) if evaluate(m.group(1), env) else evaluate(m.group(3), env)
    names = dict(env)
    names.update(sin=lambda a: math.sin(math.radians(a)), cos=lambda a: math.cos(math.radians(a)),
                 min=min, max=max, PI=math.pi, abs=abs, sqrt=math.sqrt)
    if not re.fullmatch(r'[\w\s.+\-*/(),<>=!]*', e):
        raise ValueError('expression not understood: ' + expr)
    return eval(e, {'__builtins__': {}}, names)  # noqa: S307 - the expression is checked above


def resolve(doc, inputs):
    """Every variable's value, for the inputs given."""
    exprs = doc.variables()
    env = {'size_width': inputs['size'], 'size_height': inputs['size']}
    env.update({k: v for k, v in inputs.items() if k != 'size'})
    for _ in range(len(exprs) + 1):
        for name, expr in exprs.items():
            if name in env or expr is None or name == 'size':
                continue
            try:
                env[name] = evaluate(expr, env)
            except (NameError, TypeError):
                pass
    return env


def colour_of(doc, c):
    c = doc.r(c)
    if not isinstance(c, dict) or doc.cls(c) != 'PPColor':
        return None
    name = doc.r(c.get('name'))
    if name == 'primaryColor':
        return 'lit'
    if name == 'secondaryColor':
        return 'dim'
    raise ValueError('a colour that is neither primary nor secondary: %s' % name)


def point(s):
    x, y = re.match(r'\{([-\d.e]+), ([-\d.e]+)\}', s).groups()
    return float(x), float(y)


def bezier_contours(doc, o):
    path = doc.r(o['path'])
    closed_flags = [doc.r(x) for x in doc.items_raw(doc.r(path['contoursClosedStatus']), 'NS.objects')]
    out = []
    for ci, contour in enumerate(doc.items(doc.r(path['contours']))):
        pts = []
        for p in doc.items(contour):
            pos = point(doc.r(p['position']))
            ent, ext = point(doc.r(p['enteringControlPoint'])), point(doc.r(p['exitingControlPoint']))
            pts.append((pos, (pos[0] + ent[0], pos[1] + ent[1]), (pos[0] + ext[0], pos[1] + ext[1]), ent, ext))
        closed = bool(closed_flags[ci]) if ci < len(closed_flags) else False
        segs = []
        pairs = list(zip(pts, pts[1:])) + ([(pts[-1], pts[0])] if closed else [])
        for a, b in pairs:
            if a[4] == (0.0, 0.0) and b[3] == (0.0, 0.0):
                segs.append(('L', b[0]))
            else:
                segs.append(('C', a[2], b[1], b[0]))
        out.append([closed, pts[0][0], segs])
    return out


def arc_cubic(cx, cy, r, a0, a1):
    """A circular arc as one cubic, a0 to a1 (radians, at most a quarter turn)."""
    k = 4 / 3 * math.tan((a1 - a0) / 4)
    p0 = (cx + r * math.cos(a0), cy + r * math.sin(a0))
    p1 = (cx + r * math.cos(a1), cy + r * math.sin(a1))
    c1 = (p0[0] - k * r * math.sin(a0), p0[1] + k * r * math.cos(a0))
    c2 = (p1[0] + k * r * math.sin(a1), p1[1] - k * r * math.cos(a1))
    return ('C', c1, c2, p1)


def rect_contours(doc, o):
    x, y, w, h = (float(doc.r(o[k])) for k in ('x', 'y', 'width', 'height'))
    rad = min(float(doc.r(o.get('cornerRadius', 0)) or 0), w / 2, h / 2)
    # y up: the top is y + h; corners as PaintCode shows them (top: the top on screen)
    corners = {'tl': doc.r(o.get('isTopLeftCornerRounded', True)), 'tr': doc.r(o.get('isTopRightCornerRounded', True)),
               'br': doc.r(o.get('isBottomRightCornerRounded', True)), 'bl': doc.r(o.get('isBottomLeftCornerRounded', True))}
    q = lambda c: rad if corners[c] else 0
    segs = []
    start = (x + q('bl'), y)
    segs.append(('L', (x + w - q('br'), y)))
    if q('br'):
        segs.append(arc_cubic(x + w - rad, y + rad, rad, -math.pi / 2, 0))
    segs.append(('L', (x + w, y + h - q('tr'))))
    if q('tr'):
        segs.append(arc_cubic(x + w - rad, y + h - rad, rad, 0, math.pi / 2))
    segs.append(('L', (x + q('tl'), y + h)))
    if q('tl'):
        segs.append(arc_cubic(x + rad, y + h - rad, rad, math.pi / 2, math.pi))
    segs.append(('L', (x, y + q('bl'))))
    if q('bl'):
        segs.append(arc_cubic(x + rad, y + rad, rad, math.pi, 3 * math.pi / 2))
    return [[True, start, segs]]


def oval_contours(doc, o):
    x, y, w, h = (float(doc.r(o[k])) for k in ('x', 'y', 'width', 'height'))
    cx, cy, rx, ry = x + w / 2, y + h / 2, w / 2, h / 2
    segs = [arc_cubic(0, 0, 1, i * math.pi / 2, (i + 1) * math.pi / 2) for i in range(4)]
    scale = lambda p: (cx + p[0] * rx, cy + p[1] * ry)
    return [[True, scale((1, 0)), [('C', scale(s[1]), scale(s[2]), scale(s[3])) for s in segs]]]


def driven(ex, key, env):
    """A property an expression drives: its value as drawn, moved as far as the expression moved
    from the document's own inputs (what PaintCode's generated code does)."""
    expr, value = ex[key]
    return value + evaluate(expr, env) - evaluate(expr, env['design'])


def node_values(doc, o, env):
    """Anchor, rotation and scale, with any expression's value (display values are y down)."""
    v = {k: float(doc.r(o[k])) for k in ('anchorX', 'anchorY', 'rotation', 'scaleX', 'scaleY')}
    ex = doc.expressions(o)
    for key, name, sign in (('displayAnchorX', 'anchorX', 1), ('displayAnchorY', 'anchorY', -1), ('displayRotation', 'rotation', 1),
                            ('displayScaleX', 'scaleX', 1), ('displayScaleY', 'scaleY', 1)):
        if key in ex:
            v[name] = sign * driven(ex, key, env)
    return v, ex


def walk(doc, o, m, env, out):
    c = doc.cls(o)
    if doc.r(o.get('isHidden', False)):
        return
    v, ex = node_values(doc, o, env)
    here = mul(m, node_matrix(v['anchorX'], v['anchorY'], v['rotation'], v['scaleX'], v['scaleY']))
    if c == 'PPGroup':
        for ch in doc.items(doc.r(o['shapesAndGroups'])):
            walk(doc, ch, here, env, out)
        return
    if c == 'PPBezier':
        contours = bezier_contours(doc, o)
    elif c == 'PPRectangle':
        contours = rect_contours(doc, o)
    elif c == 'PPOval':
        contours = oval_contours(doc, o)
    else:
        raise ValueError('a shape this baker does not read: %s' % c)
    contours = path_transform(contours, here)
    scale = math.sqrt(abs(here[0] * here[3] - here[1] * here[2]))
    fill, stroke = colour_of(doc, o.get('fill')), colour_of(doc, o.get('strokeColor'))
    if fill:
        out.append({'op': 'evenodd' if doc.r(o.get('windingRule', 0)) == 1 else 'fill', 'colour': fill,
                    'width': 0, 'round': False, 'contours': contours})
    width = float(doc.r(o.get('strokeWidth', 0)))
    if stroke and width > 0:
        if doc.r(o.get('lineCapStyle', 0)) != 0:
            raise ValueError('a stroke cap this baker does not draw')
        sc = contours
        if doc.r(o.get('hasStrokePattern', False)):
            dash = driven(ex, 'strokePatternDash', env) if 'strokePatternDash' in ex else float(doc.r(o['strokePatternDash']))
            if float(doc.r(o['strokePatternGap'])) < 100 or float(doc.r(o.get('strokePatternPhase', 0))) != 0:
                raise ValueError('a dash pattern this baker does not draw')
            sc = truncated(contours, dash * scale)
        out.append({'op': 'stroke', 'colour': stroke, 'width': width * scale,
                    'round': doc.r(o.get('lineJoinStyle', 0)) == 1, 'contours': sc})


# The inputs the documents were drawn with.
DESIGN = {'roundabout_angle': 90, 'flipHorizontally': False}


def canvas_paths(doc, canvas, inputs):
    env = resolve(doc, inputs)
    env['design'] = resolve(doc, dict(DESIGN, size=inputs['size']))
    size = float(re.match(r'\{\{[-\d.]+, [-\d.]+\}, \{([\d.]+), [\d.]+\}\}', doc.r(canvas['bounds'])).group(1))
    out = []
    # the canvas is y up from its bottom left, the box y down from its top left
    walk(doc, doc.r(canvas['rootGroup']), (1, 0, 0, -1, 0, size), env, out)
    return size, out


# ---- SVG paths ----

def svg_contours(d):
    toks = re.findall(r'[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:e-?\d+)?', d)
    i, cmd, out, cur = 0, None, [], None
    pos = (0.0, 0.0)
    last_ctrl = None
    start = None

    def num():
        nonlocal i
        i += 1
        return float(toks[i - 1])
    while i < len(toks):
        if re.match(r'[A-Za-z]', toks[i]):
            cmd = toks[i]
            i += 1
            if cmd in 'Zz':
                if cur:
                    cur[0] = True
                    pos = start
                cur = None
                last_ctrl = None
                continue
        rel = cmd.islower()
        base = pos if rel else (0.0, 0.0)
        c = cmd.upper()
        if c == 'M':
            p = (base[0] + num(), base[1] + num())
            cur = [False, p, []]
            out.append(cur)
            start = pos = p
            cmd = 'l' if rel else 'L'
            last_ctrl = None
            continue
        if cur is None:
            cur = [False, pos, []]
            out.append(cur)
            start = pos
        if c == 'L':
            p = (base[0] + num(), base[1] + num())
            cur[2].append(('L', p))
            last_ctrl = None
        elif c == 'H':
            p = ((pos[0] if rel else 0) + num(), pos[1])
            cur[2].append(('L', p))
            last_ctrl = None
        elif c == 'V':
            p = (pos[0], (pos[1] if rel else 0) + num())
            cur[2].append(('L', p))
            last_ctrl = None
        elif c == 'C':
            c1 = (base[0] + num(), base[1] + num())
            c2 = (base[0] + num(), base[1] + num())
            p = (base[0] + num(), base[1] + num())
            cur[2].append(('C', c1, c2, p))
            last_ctrl = ('C', c2)
        elif c == 'S':
            c1 = (2 * pos[0] - last_ctrl[1][0], 2 * pos[1] - last_ctrl[1][1]) if last_ctrl and last_ctrl[0] == 'C' else pos
            c2 = (base[0] + num(), base[1] + num())
            p = (base[0] + num(), base[1] + num())
            cur[2].append(('C', c1, c2, p))
            last_ctrl = ('C', c2)
        elif c in 'QT':
            if c == 'Q':
                q = (base[0] + num(), base[1] + num())
            else:
                q = (2 * pos[0] - last_ctrl[1][0], 2 * pos[1] - last_ctrl[1][1]) if last_ctrl and last_ctrl[0] == 'Q' else pos
            p = (base[0] + num(), base[1] + num())
            cur[2].append(('C', (pos[0] + 2 / 3 * (q[0] - pos[0]), pos[1] + 2 / 3 * (q[1] - pos[1])),
                           (p[0] + 2 / 3 * (q[0] - p[0]), p[1] + 2 / 3 * (q[1] - p[1])), p))
            last_ctrl = ('Q', q)
        elif c == 'A':
            rx, ry, phi, large, sweep = num(), num(), num(), num(), num()
            p = (base[0] + num(), base[1] + num())
            cur[2].extend(svg_arc(pos, rx, ry, phi, int(large), int(sweep), p))
            last_ctrl = None
        else:
            raise ValueError('SVG path command not read: ' + cmd)
        pos = cur[2][-1][-1]
    return out


def svg_arc(p0, rx, ry, phi, large, sweep, p1):
    """An SVG arc as cubics (the endpoint parameterisation, SVG 1.1 F.6.5)."""
    if rx == 0 or ry == 0 or p0 == p1:
        return [('L', p1)]
    rx, ry = abs(rx), abs(ry)
    cp, sp = math.cos(math.radians(phi)), math.sin(math.radians(phi))
    dx, dy = (p0[0] - p1[0]) / 2, (p0[1] - p1[1]) / 2
    x1, y1 = cp * dx + sp * dy, -sp * dx + cp * dy
    lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry)
    if lam > 1:
        rx, ry = rx * math.sqrt(lam), ry * math.sqrt(lam)
    num = rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1
    co = math.sqrt(max(0, num / (rx * rx * y1 * y1 + ry * ry * x1 * x1)))
    if large == sweep:
        co = -co
    cx1, cy1 = co * rx * y1 / ry, -co * ry * x1 / rx
    cx, cy = cp * cx1 - sp * cy1 + (p0[0] + p1[0]) / 2, sp * cx1 + cp * cy1 + (p0[1] + p1[1]) / 2
    ang = lambda ux, uy, vx, vy: math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
    t0 = ang(1, 0, (x1 - cx1) / rx, (y1 - cy1) / ry)
    dt = ang((x1 - cx1) / rx, (y1 - cy1) / ry, (-x1 - cx1) / rx, (-y1 - cy1) / ry)
    if not sweep and dt > 0:
        dt -= 2 * math.pi
    elif sweep and dt < 0:
        dt += 2 * math.pi
    n = max(1, int(math.ceil(abs(dt) / (math.pi / 2) - 1e-9)))
    segs = []
    for k in range(n):
        a0, a1 = t0 + dt * k / n, t0 + dt * (k + 1) / n
        _, c1, c2, e = arc_cubic(0, 0, 1, a0, a1)
        tr = lambda q: (cx + rx * q[0] * cp - ry * q[1] * sp, cy + rx * q[0] * sp + ry * q[1] * cp)
        segs.append(('C', tr(c1), tr(c2), p1 if k == n - 1 else tr(e)))
    return segs


def svg_icon(path, share):
    """An SVG's paths, fitted into the 32 box: its viewBox's larger side `share` of the box, centred."""
    with open(path) as f:
        text = f.read()
    vb = [float(v) for v in re.search(r'viewBox="([^"]+)"', text).group(1).replace(',', ' ').split()]
    side = max(vb[2], vb[3]) / share
    k = 32 / side
    m = (k, 0, 0, k, -k * (vb[0] - (side - vb[2]) / 2), -k * (vb[1] - (side - vb[3]) / 2))
    out = []
    for attrs in re.findall(r'<path\b([^>]*)/?>', text):
        d = re.search(r'\bd="([^"]+)"', attrs).group(1)
        fill = re.search(r'\bfill="([^"]+)"', attrs)
        colour = 'dim' if fill and fill.group(1).lower() not in ('#fff', '#ffffff', 'white') else 'lit'
        rule = re.search(r'\bfill-rule="([^"]+)"', attrs)
        out.append({'op': 'evenodd' if rule and rule.group(1) == 'evenodd' else 'fill', 'colour': colour, 'width': 0,
                    'round': False, 'contours': path_transform(svg_contours(d), m)})
    return out


# ---- output ----

def fmt(v):
    s = ('%.3f' % v).rstrip('0').rstrip('.')
    return '0' if s in ('-0', '') else s


def flit(v):
    """A C++ float literal."""
    s = fmt(v)
    return s + 'f' if '.' in s else s


def as_svg(box, paths):
    body = []
    for p in paths:
        d = []
        for closed, start, segs in p['contours']:
            d.append('M%s %s' % (fmt(start[0]), fmt(start[1])))
            for s in segs:
                d.append(('L%s %s' % (fmt(s[1][0]), fmt(s[1][1]))) if s[0] == 'L' else
                         'C' + ' '.join('%s %s' % (fmt(q[0]), fmt(q[1])) for q in s[1:]))
            if closed:
                d.append('Z')
        col = '#ffffff' if p['colour'] == 'lit' else '#7d8389'
        if p['op'] == 'stroke':
            body.append('<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linejoin="%s"/>' %
                        (''.join(d), col, fmt(p['width']), 'round' if p['round'] else 'miter'))
        else:
            body.append('<path d="%s" fill="%s" fill-rule="%s"/>' % (''.join(d), col, 'evenodd' if p['op'] == 'evenodd' else 'nonzero'))
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 %s %s" width="128" height="128">%s</svg>\n' % (
        fmt(box), fmt(box), ''.join(body))


def lane_name(canvas):
    """'lane straight or turn using turn' as 'lane_straight_or_turn_using_turn'."""
    return canvas.replace(' ', '_')


def bake(maneuvers, lanes):
    icons = []
    mdoc, ldoc = Doc(maneuvers), Doc(lanes)
    mc, lc = mdoc.canvases(), ldoc.canvases()
    for name, canvas in MANEUVERS.items():
        size, paths = canvas_paths(mdoc, mc[canvas], {'size': 32})
        icons.append((name, size, [dict(p, contours=shrink_heads(p['contours'], HEAD_SCALE)) for p in paths]))
    for a in range(ROUNDABOUT_MIN, ROUNDABOUT_MAX + 1, ROUNDABOUT_STEP):
        size, paths = canvas_paths(mdoc, mc['roundabout'], {'size': 32, 'roundabout_angle': a})
        icons.append(('roundabout_%d' % a, size, [dict(p, contours=shrink_heads(p['contours'], HEAD_SCALE)) for p in paths]))
    for name, (fname, share) in SVGS.items():
        icons.append((name, 32.0, svg_icon(os.path.join(ICONS_DIR, fname), share)))
    for canvas in sorted(lc):
        if not canvas.startswith('lane '):
            continue
        size, paths = canvas_paths(ldoc, lc[canvas], {'size': 30, 'flipHorizontally': False})
        icons.append((lane_name(canvas), size, paths))
    return icons


HEADER = '''// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* Made by tools/bake_card_icons.py: do not edit. The HUD turn card's icons
 * (card_icons.h). Mapbox's turn and lane icons (mapbox/navigation-ui-resources,
 * CC0 1.0), their turn arrows' heads drawn at %d %%; OsmAnd's three-way forks
 * and lane changes (GPL-3.0-or-later); Material Symbols' flyover, boat and
 * train (Apache-2.0); Maki's tunnel (CC0 1.0). Sources: icons/README.md. */
#include "card_icons.h"

#include <string.h>

namespace woc {
namespace card {
'''

FOOTER = '''
const Icon *find_icon(const char *name)
{
    for (const Icon &i : kIcons)
        if (strcmp(i.name, name) == 0)
            return &i;
    return nullptr;
}

const Icon *icons_begin() { return kIcons; }
const Icon *icons_end() { return kIcons + sizeof kIcons / sizeof kIcons[0]; }

}  // namespace card
}  // namespace woc
'''

OPS = {'fill': 0, 'evenodd': 1, 'stroke': 2}


def cpp(icons):
    nums, paths, table = [], [], []
    for name, box, ps in icons:
        first = len(paths)
        for p in ps:
            n = path_numbers(p['contours'])
            paths.append('    {%d, %d, %d, %s, %d, %d},' % (OPS[p['op']], 1 if p['colour'] == 'dim' else 0, 1 if p['round'] else 0,
                                                      flit(p['width']), len(nums), len(n)))
            nums += n
        table.append('    {"%s", %s, %d, %d},' % (name, flit(box), first, len(paths) - first))
    lines = [HEADER % round(HEAD_SCALE * 100), 'static const float kNums[] = {']
    row = []
    for v in nums:
        row.append(flit(v))
        if len(row) == 16:
            lines.append('    ' + ', '.join(row) + ',')
            row = []
    if row:
        lines.append('    ' + ', '.join(row) + ',')
    lines.append('};\n')
    lines.append('const float *const kIconNumbers = kNums;\n')
    lines.append('static const IconPath kPathTable[] = {')
    lines += paths
    lines.append('};\n')
    lines.append('const IconPath *const kIconPaths = kPathTable;\n')
    lines.append('static const Icon kIcons[] = {')
    lines += table
    lines.append('};')
    return '\n'.join(lines) + FOOTER


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--maneuvers', required=True, help="Mapbox's Maneuvers.pcvd")
    ap.add_argument('--lanes', required=True, help="Mapbox's Lanes.pcvd")
    ap.add_argument('--svg', help='write each icon as an SVG into this folder instead')
    a = ap.parse_args()
    icons = bake(a.maneuvers, a.lanes)
    if a.svg:
        os.makedirs(a.svg, exist_ok=True)
        for name, box, paths in icons:
            with open(os.path.join(a.svg, name + '.svg'), 'w') as f:
                f.write(as_svg(box, paths))
        print('%d icons' % len(icons), file=sys.stderr)
        return
    sys.stdout.write(cpp(icons))


if __name__ == '__main__':
    main()
