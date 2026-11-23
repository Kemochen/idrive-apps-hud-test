// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
#include "card_draw.h"

#include <algorithm>
#include <cmath>

#include "card_font.h"
#include "card_pick.h"
#include "card_raster.h"
#include "card_shapes.h"

namespace woc {

namespace {

using card::Pt;

struct Colour {
    uint8_t r, g, b;
};
const Colour kWhite{255, 255, 255};
const Colour kRoadGrey{141, 147, 153};   /* a road not taken, a roundabout's ring */
const Colour kLaneGrey{107, 112, 117};   /* an arrow not to take in a lane, the lines between lanes */

/* The design's measures at 100 %, in pixels. */
const float kTextPx = 26, kDigitPx = 28, kArrowPx = 36, kArrowGap = 10, kUnitGap = 8, kNameGap = 16;
/* Noto Sans's capital height, of its size: lettering is centred by it. */
const float kCapHeight = 0.714f;
const float kLaneLine = 2, kLaneLineTop = 2, kLaneLineBottom = 34, kDash = 8, kDashGap = 6;

float clamp01(float v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

/* A picture being drawn: coverage painted over what is there. */
class Canvas {
public:
    Canvas(unsigned w, unsigned h, CardImage *out) : w_((int)w), h_((int)h), out_(out)
    {
        out->w = w;
        out->h = h;
        out->rgba.assign((size_t)w * h * 4, 0);
    }
    int w() const { return w_; }
    int h() const { return h_; }

    void paint(int x, int y, float cover, Colour c)
    {
        if (x < 0 || y < 0 || x >= w_ || y >= h_ || cover <= 0)
            return;
        uint8_t *p = &out_->rgba[((size_t)y * w_ + x) * 4];
        const float a = clamp01(cover), under = p[3] / 255.0f * (1 - a), all = a + under;
        p[0] = (uint8_t)((c.r * a + p[0] * under) / all + 0.5f);
        p[1] = (uint8_t)((c.g * a + p[1] * under) / all + 0.5f);
        p[2] = (uint8_t)((c.b * a + p[2] * under) / all + 0.5f);
        p[3] = (uint8_t)(all * 255 + 0.5f);
    }

private:
    int w_, h_;
    CardImage *out_;
};

float distance(Pt p, Pt a, Pt b)
{
    const float vx = b.x - a.x, vy = b.y - a.y, len2 = vx * vx + vy * vy;
    const float t = len2 > 0 ? clamp01(((p.x - a.x) * vx + (p.y - a.y) * vy) / len2) : 0;
    return std::hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy));
}

/* How much of the pixel at p a line covers. */
float line_cover(const card::Line &l, Pt p)
{
    float d = std::hypot(p.x - l.pts[0].x, p.y - l.pts[0].y);
    for (size_t i = 1; i < l.pts.size(); i++)
        d = std::min(d, distance(p, l.pts[i - 1], l.pts[i]));
    float cover = clamp01(l.width / 2 - d + 0.5f);
    if (l.flat && l.pts.size() > 1 && cover > 0) {
        /* nothing behind the start, seen along the first piece */
        const float vx = l.pts[1].x - l.pts[0].x, vy = l.pts[1].y - l.pts[0].y, len = std::hypot(vx, vy);
        if (len > 0)
            cover *= clamp01(((p.x - l.pts[0].x) * vx + (p.y - l.pts[0].y) * vy) / len + 0.5f);
    }
    return cover;
}

/* How much of the pixel at p a triangle covers. */
float head_cover(const card::Head &h, Pt p)
{
    const Pt v[3] = {h.a, h.b, h.c};
    const float turn = (v[1].x - v[0].x) * (v[2].y - v[0].y) - (v[1].y - v[0].y) * (v[2].x - v[0].x);
    float inside = 1e9f;
    for (int i = 0; i < 3; i++) {
        const Pt a = v[i], b = v[(i + 1) % 3];
        const float ex = b.x - a.x, ey = b.y - a.y, len = std::hypot(ex, ey);
        if (len <= 0)
            return 0;
        const float side = (ex * (p.y - a.y) - ey * (p.x - a.x)) / len;
        inside = std::min(inside, turn >= 0 ? side : -side);
    }
    return clamp01(inside + 0.5f);
}

/* A shape of `unit` pixels a box unit, its box's top-left at (ox, oy). */
card::Shape placed(card::Shape s, float ox, float oy, float unit)
{
    const auto at = [&](Pt p) { return Pt{ox + p.x * unit, oy + p.y * unit}; };
    for (card::Line &l : s.lines) {
        for (Pt &p : l.pts)
            p = at(p);
        l.width *= unit;
    }
    for (card::Head &h : s.heads)
        h = card::Head{at(h.a), at(h.b), at(h.c)};
    return s;
}

/* Paints a placed shape within the box of its pixels: its grey lines, then
 * its other lines and heads as one piece in `colour`. */
void paint_shape(Canvas *c, const card::Shape &s, int x0, int y0, int x1, int y1, Colour colour, Colour grey)
{
    for (int y = std::max(0, y0); y < std::min(c->h(), y1); y++) {
        for (int x = std::max(0, x0); x < std::min(c->w(), x1); x++) {
            const Pt p{x + 0.5f, y + 0.5f};
            float dim = 0, lit = 0;
            for (const card::Line &l : s.lines)
                (l.dim ? dim : lit) = std::max(l.dim ? dim : lit, line_cover(l, p));
            for (const card::Head &h : s.heads)
                lit = std::max(lit, head_cover(h, p));
            c->paint(x, y, dim, grey);
            c->paint(x, y, lit, colour);
        }
    }
}

/* An icon (card_icons.h) `size` pixels square, its top left at (x, y):
 * each path in turn, white or `grey`, cut at the square's edges as Mapbox's
 * own views cut them (a stem drawn past its box's foot). */
void paint_icon(Canvas *c, const card::Pick &pick, float x, float y, float size, Colour grey)
{
    const auto inside = [&](int px, int py) { return px + 0.5f >= x && px + 0.5f < x + size && py + 0.5f >= y && py + 0.5f < y + size; };
    card::IconPlace at;
    at.x = x;
    at.y = y;
    at.unit = size / pick.icon->box;
    at.mirror = pick.mirror;
    card::Cover cover;
    for (uint32_t i = 0; i < pick.icon->size; i++) {
        const card::IconPath &path = card::kIconPaths[pick.icon->at + i];
        card::path_cover(*pick.icon, path, at, c->w(), c->h(), &cover);
        for (int py = 0; py < cover.h; py++)
            for (int px = 0; px < cover.w; px++)
                if (inside(cover.x0 + px, cover.y0 + py))
                    c->paint(cover.x0 + px, cover.y0 + py, cover.v[(size_t)py * cover.w + px], path.grey ? grey : kWhite);
    }
}

/* UTF-8 as characters; false for text that is not UTF-8. */
bool characters(const std::string &text, std::vector<uint32_t> *out)
{
    out->clear();
    for (size_t i = 0; i < text.size();) {
        const uint8_t b = (uint8_t)text[i];
        const int more = b < 0x80 ? 0 : (b & 0xE0) == 0xC0 ? 1 : (b & 0xF0) == 0xE0 ? 2 : (b & 0xF8) == 0xF0 ? 3 : -1;
        if (more < 0 || i + more >= text.size())
            return false;
        uint32_t cp = more == 0 ? b : b & (0x3F >> more);
        for (int k = 1; k <= more; k++) {
            const uint8_t next = (uint8_t)text[i + k];
            if ((next & 0xC0) != 0x80)
                return false;
            cp = (cp << 6) | (next & 0x3F);
        }
        out->push_back(cp);
        i += more + 1;
    }
    return true;
}

/* Every character has a glyph in the font. */
bool lettered(const CardFont &f, const std::vector<uint32_t> &text)
{
    return std::all_of(text.begin(), text.end(), [&](uint32_t cp) { return card_glyph(f, cp) != nullptr; });
}

/* The width of lettered text drawn `px` high. */
float text_width(const CardFont &f, const std::vector<uint32_t> &text, float px)
{
    float w = 0;
    for (uint32_t cp : text)
        w += card_glyph(f, cp)->advance / 16.0f;
    return w * px / f.px;
}

float glyph_pixel(const CardFont &f, const CardGlyph &g, int x, int y)
{
    const size_t i = (size_t)y * g.w + x;
    const uint8_t byte = f.pixels[g.off + i / 2];
    return ((i & 1) ? byte & 15 : byte >> 4) / 15.0f;
}

/* One glyph, its pen at (pen, baseline), drawn `k` times its baked size
 * (k <= 1): each pixel is the average of the glyph under it. */
void paint_glyph(Canvas *c, const CardFont &f, const CardGlyph &g, float pen, float baseline, float k, Colour colour)
{
    const float left = pen + g.left * k, top = baseline - g.top * k;
    const int x1 = (int)std::ceil(left + g.w * k), y1 = (int)std::ceil(top + g.h * k);
    for (int y = (int)std::floor(top); y < y1; y++) {
        const float sy0 = std::max(0.0f, (y - top) / k), sy1 = std::min((float)g.h, (y + 1 - top) / k);
        for (int x = (int)std::floor(left); x < x1; x++) {
            const float sx0 = std::max(0.0f, (x - left) / k), sx1 = std::min((float)g.w, (x + 1 - left) / k);
            float sum = 0;
            for (int sy = (int)sy0; sy < sy1; sy++) {
                const float rows = std::min(sy1, sy + 1.0f) - std::max(sy0, (float)sy);
                for (int sx = (int)sx0; sx < sx1; sx++)
                    sum += glyph_pixel(f, g, sx, sy) * rows * (std::min(sx1, sx + 1.0f) - std::max(sx0, (float)sx));
            }
            c->paint(x, y, sum * k * k, colour);
        }
    }
}

void paint_text(Canvas *c, const CardFont &f, const std::vector<uint32_t> &text, float x, float baseline, float px,
                Colour colour)
{
    const float k = px / f.px;
    for (uint32_t cp : text) {
        const CardGlyph *g = card_glyph(f, cp);
        if (g->w && g->h)
            paint_glyph(c, f, *g, x, baseline, k, colour);
        x += g->advance / 16.0f * k;
    }
}

/* The baseline of lettering `px` high centred on y. */
float centred_baseline(float y, float px) { return y + kCapHeight * px / 2; }

/* The street's name to fit `room` pixels: whole, cut with an ellipsis, or
 * none (no room, no name, or a letter the lettering lacks). */
std::vector<uint32_t> fitted_name(const std::string &road, float px, float room)
{
    std::vector<uint32_t> name;
    if (!characters(road, &name) || !lettered(kCardText, name))
        return {};
    while (!name.empty() && name.back() == ' ')
        name.pop_back();
    if (name.empty() || room < 2 * px)
        return {};
    if (text_width(kCardText, name, px) <= room)
        return name;
    const uint32_t ellipsis = 0x2026;
    if (!card_glyph(kCardText, ellipsis))
        return {};
    do {
        name.pop_back();
        while (!name.empty() && name.back() == ' ')
            name.pop_back();
        name.push_back(ellipsis);
        if (text_width(kCardText, name, px) <= room)
            return name;
        name.pop_back();
    } while (!name.empty());
    return {};
}

/* The distance as its number and its unit ("450", "m"); both empty when
 * either has a character its lettering lacks. */
void distance_parts(const std::string &dist, std::vector<uint32_t> *number, std::vector<uint32_t> *unit)
{
    const size_t space = dist.rfind(' ');
    const bool split = space != std::string::npos && space + 1 < dist.size();
    if (!characters(split ? dist.substr(0, space) : dist, number) || !lettered(kCardDigits, *number) ||
        !characters(split ? dist.substr(space + 1) : std::string(), unit) || !lettered(kCardText, *unit)) {
        number->clear();
        unit->clear();
    }
}

}  // namespace

void draw_card_row(const Turn &turn, float scale, unsigned w, unsigned h, CardImage *out)
{
    Canvas c(w, h, out);
    if (turn.empty() || !w || !h)
        return;
    const float arrow = std::min({kArrowPx * scale, (float)h, (float)w});
    const float text_px = kTextPx * scale, digit_px = kDigitPx * scale, mid = h / 2.0f;

    std::vector<uint32_t> number, unit;
    distance_parts(turn.dist, &number, &unit);
    const float number_w = number.empty() ? 0 : text_width(kCardDigits, number, digit_px);
    const float unit_w = unit.empty() ? 0 : kUnitGap * scale + text_width(kCardText, unit, text_px);
    float dist_w = number.empty() ? 0 : kArrowGap * scale + number_w + unit_w;
    if (arrow + dist_w > w)
        dist_w = 0;   /* no room: the arrow only */
    /* whole pixels, so the arrow is the same picture wherever it is */
    const float group = std::floor(w - arrow - dist_w), top = std::floor((h - arrow) / 2);

    const card::Pick icon = card::turn_icon(turn);
    if (icon.icon) {
        paint_icon(&c, icon, group, top, arrow, kRoadGrey);
    } else {
        const card::Shape shape = placed(card::turn_shape(turn.arrow), group, top, arrow / card::kTurnBox);
        paint_shape(&c, shape, (int)std::floor(group), 0, (int)std::ceil(group + arrow), (int)h, kWhite, kRoadGrey);
    }
    if (dist_w > 0) {
        const float x = group + arrow + kArrowGap * scale, baseline = centred_baseline(mid, digit_px);
        paint_text(&c, kCardDigits, number, x, baseline, digit_px, kWhite);
        paint_text(&c, kCardText, unit, x + number_w + kUnitGap * scale, baseline, text_px, kWhite);
    }
    const std::vector<uint32_t> name = fitted_name(turn.road, text_px, group - kNameGap * scale);
    paint_text(&c, kCardText, name, 0, centred_baseline(mid, text_px), text_px, kWhite);
}

void draw_card_lanes(const std::string &lanes, float scale, unsigned w, unsigned h, CardImage *out)
{
    Canvas c(w, h, out);
    std::vector<std::string> items;
    for (size_t at = 0; at <= lanes.size() && !lanes.empty() && items.size() < kCardLanes;) {
        const size_t comma = std::min(lanes.find(',', at), lanes.size());
        items.push_back(lanes.substr(at, comma - at));
        at = comma + 1;
    }
    if (items.empty() || !w || !h)
        return;
    const float cell = card_detail::kLaneW * scale, line = kLaneLine * scale;
    const float x0 = w - (items.size() * cell + line);
    /* the lines: one before each lane and one after the last */
    for (size_t i = 0; i <= items.size(); i++) {
        const float x = x0 + line / 2 + i * cell;
        card::Shape dashes;
        for (float y = kLaneLineTop; y < kLaneLineBottom; y += kDash + kDashGap)
            dashes.lines.push_back(card::Line{{{x, y * scale}, {x, std::min(y + kDash, kLaneLineBottom) * scale}}, line, true, false});
        /* cut square at both ends: the last pixel row of a dash is its end */
        for (card::Line &d : dashes.lines)
            d.pts[1].y -= line / 2;
        paint_shape(&c, dashes, (int)std::floor(x - line), 0, (int)std::ceil(x + line), (int)h, kLaneGrey, kLaneGrey);
    }
    /* each lane's icon fills its place, the lines at its edges drawn over */
    const float size = std::min(cell, (float)h), top = std::floor((h - size) / 2);
    for (size_t i = 0; i < items.size(); i++) {
        const card::Pick icon = card::lane_icon(items[i]);
        if (icon.icon)
            paint_icon(&c, icon, x0 + line / 2 + i * cell + (cell - size) / 2, top, size, kLaneGrey);
        const auto &item = items[i];
        if (icon.icon && item.size() >= 2 && item.compare(item.size() - 2, 2, "+!") == 0) {
            const float x = x0 + line / 2 + (i + 0.5f) * cell;
            const float y = h - 3 * scale;
            card::Shape marker;
            marker.lines.push_back(card::Line{{{x - cell / 5, y}, {x + cell / 5, y}}, 3 * scale, true, false});
            paint_shape(&c, marker, (int)std::floor(x - cell / 2), 0, (int)std::ceil(x + cell / 2), (int)h, kWhite, kWhite);
        }
    }
}

}  // namespace woc
