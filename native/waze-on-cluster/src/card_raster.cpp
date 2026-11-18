// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
#include "card_raster.h"

#include <algorithm>
#include <cmath>
#include <limits>
#include <utility>

namespace woc {
namespace card {

namespace {

struct P {
    float x, y;
};

struct Contour {
    std::vector<P> pts;
    bool closed = false;
};

const int kSubRows = 4;

float clamp01(float v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/* The path's contours in pixels, its curves cut into short lines. */
std::vector<Contour> contours(const Icon &icon, const IconPath &path, const IconPlace &at)
{
    const float *n = kIconNumbers + path.at, *end = n + path.size;
    const auto px = [&](float x, float y) {
        return P{at.x + (at.mirror ? icon.box - x : x) * at.unit, at.y + y * at.unit};
    };
    std::vector<Contour> out;
    P pen{0, 0};
    while (n < end) {
        const int cmd = (int)n[0];
        if (cmd == kMove) {
            out.push_back(Contour());
            pen = px(n[1], n[2]);
            out.back().pts.push_back(pen);
            n += 3;
        } else if (cmd == kLine) {
            pen = px(n[1], n[2]);
            out.back().pts.push_back(pen);
            n += 3;
        } else if (cmd == kCurve) {
            const P a = pen, b = px(n[1], n[2]), c = px(n[3], n[4]), d = px(n[5], n[6]);
            const float len = std::hypot(b.x - a.x, b.y - a.y) + std::hypot(c.x - b.x, c.y - b.y) + std::hypot(d.x - c.x, d.y - c.y);
            const int steps = std::min(48, 2 + (int)(len / 1.5f));
            for (int i = 1; i <= steps; i++) {
                const float t = (float)i / steps, u = 1 - t;
                out.back().pts.push_back(P{u * u * u * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t * t * t * d.x,
                                           u * u * u * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t * t * t * d.y});
            }
            pen = d;
            n += 7;
        } else {
            out.back().closed = true;
            n += 1;
        }
    }
    return out;
}

/* Adds a span x a..b of a sub-row worth `weight` to a row of the cover. */
void add_span(float *row, int x0, int w, float a, float b, float weight)
{
    a = std::max(a, (float)x0);
    b = std::min(b, (float)(x0 + w));
    if (b <= a)
        return;
    const int ia = (int)std::floor(a), ib = (int)std::floor(b);
    if (ia == ib) {
        row[ia - x0] += (b - a) * weight;
        return;
    }
    row[ia - x0] += (ia + 1 - a) * weight;
    for (int i = ia + 1; i < ib; i++)
        row[i - x0] += weight;
    if (ib < x0 + w)
        row[ib - x0] += (b - ib) * weight;
}

void fill(const std::vector<Contour> &cs, bool even_odd, Cover *c)
{
    struct Edge {
        float x0, y0, x1, y1;
        int dir;
    };
    std::vector<Edge> edges;
    for (const Contour &k : cs)
        for (size_t i = 0; i < k.pts.size(); i++) {
            const P a = k.pts[i], b = k.pts[(i + 1) % k.pts.size()];
            if (a.y != b.y)
                edges.push_back(a.y < b.y ? Edge{a.x, a.y, b.x, b.y, 1} : Edge{b.x, b.y, a.x, a.y, -1});
        }
    std::vector<std::pair<float, int>> xs;
    for (int y = 0; y < c->h; y++) {
        float *row = &c->v[(size_t)y * c->w];
        for (int s = 0; s < kSubRows; s++) {
            const float sy = c->y0 + y + (s + 0.5f) / kSubRows;
            xs.clear();
            for (const Edge &e : edges)
                if (sy >= e.y0 && sy < e.y1)
                    xs.push_back({e.x0 + (sy - e.y0) * (e.x1 - e.x0) / (e.y1 - e.y0), e.dir});
            std::sort(xs.begin(), xs.end());
            int wind = 0;
            for (size_t i = 0; i + 1 < xs.size(); i++) {
                wind += xs[i].second;
                if (even_odd ? (wind & 1) : wind != 0)
                    add_span(row, c->x0, c->w, xs[i].first, xs[i + 1].first, 1.0f / kSubRows);
            }
        }
        for (int x = 0; x < c->w; x++)
            row[x] = clamp01(row[x]);
    }
}

/* The point of a line through p nearest q: how far it is, on which segment,
 * and how far along that segment's line q is (negative before its start,
 * past its length after its end). One point: the distance to it. */
struct Nearest {
    float dist;
    size_t seg;
    float along;
};

Nearest nearest(const std::vector<P> &p, P q)
{
    if (p.size() == 1)
        return Nearest{std::hypot(q.x - p[0].x, q.y - p[0].y), 0, 0};
    Nearest best{std::numeric_limits<float>::infinity(), 0, 0};
    for (size_t i = 0; i + 1 < p.size(); i++) {
        const float vx = p[i + 1].x - p[i].x, vy = p[i + 1].y - p[i].y, len2 = vx * vx + vy * vy;
        const float t = len2 > 0 ? ((q.x - p[i].x) * vx + (q.y - p[i].y) * vy) / len2 : 0;
        const float tc = clamp01(t);
        const float d = std::hypot(q.x - (p[i].x + tc * vx), q.y - (p[i].y + tc * vy));
        if (d < best.dist)
            best = Nearest{d, i, t * std::sqrt(len2)};
    }
    return best;
}

void stroke(const std::vector<Contour> &cs, float width, Cover *c)
{
    for (const Contour &k : cs) {
        std::vector<P> p = k.pts;
        if (k.closed && !p.empty())
            p.push_back(p.front());
        if (p.empty())
            continue;
        const size_t segs = p.size() - 1;
        const bool capped = !k.closed && segs > 0;
        const float last_len = segs ? std::hypot(p[segs].x - p[segs - 1].x, p[segs].y - p[segs - 1].y) : 0;
        for (int y = 0; y < c->h; y++)
            for (int x = 0; x < c->w; x++) {
                const Nearest n = nearest(p, P{c->x0 + x + 0.5f, c->y0 + y + 0.5f});
                float cover = clamp01(width / 2 - n.dist + 0.5f);
                if (cover > 0 && capped) {
                    /* square ends: nothing before the first point or after the last */
                    if (n.seg == 0 && n.along < 0)
                        cover *= clamp01(n.along + 0.5f);
                    if (n.seg == segs - 1 && n.along > last_len)
                        cover *= clamp01(last_len - n.along + 0.5f);
                }
                float &v = c->v[(size_t)y * c->w + x];
                v = std::max(v, cover);
            }
    }
}

}  // namespace

void path_cover(const Icon &icon, const IconPath &path, const IconPlace &at, int pic_w, int pic_h, Cover *out)
{
    const std::vector<Contour> cs = contours(icon, path, at);
    float x0 = 1e9f, y0 = 1e9f, x1 = -1e9f, y1 = -1e9f;
    for (const Contour &k : cs)
        for (const P &q : k.pts) {
            x0 = std::min(x0, q.x);
            y0 = std::min(y0, q.y);
            x1 = std::max(x1, q.x);
            y1 = std::max(y1, q.y);
        }
    const float pad = path.op == kIconStroke ? path.width * at.unit / 2 + 1 : 1;
    out->x0 = std::max(0, (int)std::floor(x0 - pad));
    out->y0 = std::max(0, (int)std::floor(y0 - pad));
    out->w = std::max(0, std::min(pic_w, (int)std::ceil(x1 + pad)) - out->x0);
    out->h = std::max(0, std::min(pic_h, (int)std::ceil(y1 + pad)) - out->y0);
    out->v.assign((size_t)out->w * out->h, 0.0f);
    if (cs.empty() || !out->w || !out->h)
        return;
    if (path.op == kIconStroke)
        stroke(cs, path.width * at.unit, out);
    else
        fill(cs, path.op == kIconFillEvenOdd, out);
}

}  // namespace card
}  // namespace woc
