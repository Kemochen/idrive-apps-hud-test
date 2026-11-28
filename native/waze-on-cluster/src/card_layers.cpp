// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
#include "card_layers.h"

#include <cstring>
#include <initializer_list>
#include <utility>
#include <vector>

#include "log.h"

namespace woc {

namespace {

/* The smallest rect holding every pixel of b that differs from a (the same
 * size); false when none does. */
bool changed_rect(const CardImage &a, const CardImage &b, cr::FrameRect *out)
{
    unsigned x0 = b.w, y0 = b.h, x1 = 0, y1 = 0;
    for (unsigned y = 0; y < b.h; y++) {
        const uint8_t *ra = &a.rgba[(size_t)y * b.w * 4], *rb = &b.rgba[(size_t)y * b.w * 4];
        if (!std::memcmp(ra, rb, (size_t)b.w * 4))
            continue;
        unsigned first = 0, last = b.w - 1;
        while (!std::memcmp(ra + first * 4, rb + first * 4, 4))
            first++;
        while (!std::memcmp(ra + last * 4, rb + last * 4, 4))
            last--;
        x0 = first < x0 ? first : x0;
        x1 = last > x1 ? last : x1;
        y0 = y < y0 ? y : y0;
        y1 = y;
    }
    if (x0 > x1)
        return false;
    *out = cr::FrameRect{(uint16_t)x0, (uint16_t)y0, (uint16_t)(x1 - x0 + 1), (uint16_t)(y1 - y0 + 1)};
    return true;
}

/* What a picture is drawn from: its size, its scale and the turn's fields
 * it shows. */
std::string picture_key(const CardRect &r, float scale, std::initializer_list<std::string> fields)
{
    std::string k = std::to_string(r.w) + 'x' + std::to_string(r.h) + '@' + std::to_string(scale);
    for (const std::string &f : fields)
        k += '\x1f' + f;
    return k;
}

}  // namespace

void CardLayers::set_config(const CardConfig &c)
{
    refused_ = false;
    cfg_ = c;
    update();
}

void CardLayers::set_turn(const Turn &t)
{
    if (t == turn_)
        return;
    turn_ = t;
    update();
}

void CardLayers::follow(unsigned tw, unsigned th, const CardRect &anchor, bool visible, bool yield, bool lanes_only)
{
    if (!tw)
        refused_ = false;
    tw_ = tw;
    th_ = th;
    anchor_ = anchor;
    visible_ = visible;
    yield_ = yield;
    lanes_only_ = lanes_only;
    update();
}

void CardLayers::refused(const std::string &reason)
{
    log_warn("render: no turn card on the HUD: %s", reason.c_str());
    refused_ = true;
    update();
}

void CardLayers::update()
{
    placed_ = cfg_.on && tw_ && !refused_;
    if (!placed_) {
        drop(&row_);
        drop(&road_);
        drop(&maneuver_);
        drop(&lanes_);
        return;
    }
    layout_ = card_layout(tw_, th_, anchor_, cfg_);
    const bool split = layout_.split_row();
    if (lanes_only_ || split) drop(&row_);
    else place(&row_, layout_.top);
    if (!lanes_only_ && split) {
        if (layout_.road.w) place(&road_, layout_.road);
        else drop(&road_);
        place(&maneuver_, layout_.maneuver);
    } else {
        drop(&road_);
        drop(&maneuver_);
    }
    const std::string lanes = !lanes_only_ && turn_.empty() ? std::string() : turn_.lanes;
    if (lanes_only_ && lanes.empty()) drop(&lanes_);
    else place(&lanes_, layout_.lanes);
    const float scale = layout_.scale;
    if (stale(&row_, picture_key(layout_.top, scale, {turn_.arrow, turn_.exit, turn_.angle, turn_.side, turn_.dist, turn_.road}))) {
        CardImage m;
        draw_card_row(turn_, scale, layout_.top.w, layout_.top.h, &m);
        show(&row_, std::move(m));
    }
    if (stale(&road_, picture_key(layout_.road, scale, {turn_.empty() ? std::string() : turn_.road}))) {
        CardImage m;
        draw_card_row(turn_, scale, layout_.road.w, layout_.road.h, &m, CardRowPart::Road);
        show(&road_, std::move(m));
    }
    if (stale(&maneuver_, picture_key(layout_.maneuver, scale, {turn_.arrow, turn_.exit, turn_.angle, turn_.side, turn_.dist}))) {
        CardImage m;
        draw_card_row(turn_, scale, layout_.maneuver.w, layout_.maneuver.h, &m, CardRowPart::Maneuver);
        show(&maneuver_, std::move(m));
    }
    if (stale(&lanes_, picture_key(layout_.lanes, layout_.lanes_scale, {lanes}))) {
        CardImage m;
        draw_card_lanes(lanes, layout_.lanes_scale, layout_.lanes.w, layout_.lanes.h, &m);
        show(&lanes_, std::move(m));
    }
}

/* Whether a part's picture is to be drawn: its layer has none yet, or what
 * it is drawn from changed. Takes key as drawn. */
bool CardLayers::stale(Part *p, const std::string &key)
{
    if (!p->ref || (!p->shown.rgba.empty() && p->drawn == key))
        return false;
    p->drawn = key;
    return true;
}

void CardLayers::place(Part *p, const CardRect &r)
{
    if (p->ref && (p->lo.w != r.w || p->lo.h != r.h))
        drop(p);   /* another size: another picture */
    cr::LayerOptions lo;
    lo.target = "hud";
    lo.klass = "content";
    lo.z = 1;            /* over the map */
    lo.contend = !lanes_only_;
    lo.yield = yield_;
    lo.x = r.x;
    lo.y = r.y;
    lo.w = r.w;
    lo.h = r.h;
    lo.visible = visible_;
    if (!p->ref) {
        cr::ImageOptions io;
        io.w = r.w;
        io.h = r.h;
        io.fps = 10;
        p->lo = lo;
        p->ref = client_->image(lo, io);
        p->shown = CardImage();
        log_info("render: turn card %s on the HUD, %ux%u at %d,%d", p->name, r.w, r.h, r.x, r.y);
    } else if (lo.x != p->lo.x || lo.y != p->lo.y || lo.visible != p->lo.visible || lo.yield != p->lo.yield ||
               lo.contend != p->lo.contend) {
        p->lo = lo;
        client_->set(p->ref, lo);
    }
}

void CardLayers::show(Part *p, CardImage m)
{
    if (!p->ref)
        return;
    cr::FrameRect r;
    if (p->shown.rgba.size() != m.rgba.size()) {
        client_->pixels(p->ref, {}, m.rgba.data(), m.rgba.size());
    } else if (changed_rect(p->shown, m, &r)) {
        std::vector<uint8_t> part((size_t)r.w * r.h * 4);
        for (unsigned y = 0; y < r.h; y++)
            std::memcpy(&part[(size_t)y * r.w * 4], &m.rgba[((size_t)(r.y + y) * m.w + r.x) * 4], (size_t)r.w * 4);
        client_->pixels(p->ref, {r}, part.data(), part.size());
    } else {
        return;
    }
    p->shown = std::move(m);
}

void CardLayers::drop(Part *p)
{
    if (!p->ref)
        return;
    client_->drop(p->ref);
    p->ref = 0;
    p->shown = CardImage();
}

}  // namespace woc
