// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* Where the HUD's turn card goes (turn_card.h, card_layout): the row with
 * the street, arrow and distance, and the lanes. Both use independent size
 * and offsets inside the HUD scene. The reference box is 480x212 at 160,84. */
#include "turn_card.h"

#include <stdio.h>

using namespace woc;

static int failures = 0;

static void expect(bool ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

static bool is(const CardRect &r, int x, int y, unsigned w, unsigned h)
{
    if (r.x == x && r.y == y && r.w == w && r.h == h)
        return true;
    fprintf(stderr, "  got %d,%d %ux%u, not %d,%d %ux%u\n", r.x, r.y, r.w, r.h, x, y, w, h);
    return false;
}

static CardConfig card(unsigned pct, int dx, int dy)
{
    CardConfig c;
    c.on = true;
    c.pct = pct;
    c.dx = dx;
    c.dy = dy;
    return c;
}

int main()
{
    const CardRect map{160, 84, 480, 212};

    CardLayout l = card_layout(800, 480, map, card(100, 0, 0));
    expect(is(l.top, 160, 28, 480, 44), "the row is as wide as the map, 44 high, 12 above it");
    expect(is(l.lanes, 422, 310, 218, 36), "the lanes end at the map's right edge, 14 under it, room for six 36 wide");
    expect(l.dx == 0 && l.dy == 0 && l.scale == 1.0f, "not moved, at its drawn size");

    l = card_layout(800, 480, map, card(50, 0, 0));
    expect(is(l.top, 160, 56, 480, 22) && is(l.lanes, 422, 310, 218, 36) && l.scale == 0.5f, "half-size turn card leaves the lanes alone");
    l = card_layout(800, 480, map, card(110, 0, 0));
    expect(is(l.top, 160, 23, 480, 48) && is(l.lanes, 422, 310, 218, 36), "110 %: each measure rounded on the turn card only");
    l = card_layout(800, 480, map, card(150, 0, 0));
    expect(is(l.top, 160, 0, 480, 66), "one and a half: no room over the map, the row starts at the HUD's top");
    expect(is(l.lanes, 422, 310, 218, 36) && l.dy == 0, "and the lanes stay at their own size");

    expect(card_layout(800, 480, map, card(20, 0, 0)).scale == 0.5f, "a size under 50 % is 50 %");
    expect(card_layout(800, 480, map, card(400, 0, 0)).scale == 1.5f, "a size over 150 % is 150 %");

    l = card_layout(800, 480, map, card(100, 100, -5));
    expect(is(l.top, 260, 23, 480, 44) && is(l.lanes, 422, 310, 218, 36) && l.dx == 100 && l.dy == -5,
           "moved: only the turn card follows its setting");
    l = card_layout(800, 480, map, card(100, -200, 0));
    expect(is(l.top, 0, 28, 480, 44) && l.dx == -160 && is(l.lanes, 422, 310, 218, 36),
           "moved past the left edge: held at it, the offset as far as it went");
    l = card_layout(800, 480, map, card(100, 400, -400));
    expect(is(l.top, 320, 0, 480, 44) && l.dx == 160 && l.dy == -28, "held at the right and top edges");
    l = card_layout(800, 480, map, card(100, 0, 500));
    expect(is(l.top, 160, 436, 480, 44) && l.dy == 408, "held at the bottom edge");
    CardConfig lane_settings = card(100, 0, 500);
    lane_settings.lanes_pct = 150;
    lane_settings.lanes_dx = 30;
    lane_settings.lanes_dy = 500;
    l = card_layout(800, 480, map, lane_settings);
    expect(is(l.top, 160, 436, 480, 44) && is(l.lanes, 343, 426, 327, 54) && l.lanes_dx == 30 && l.lanes_dy == 109,
           "the lanes use their own scale and are held inside the HUD independently");

    l = card_layout(800, 480, CardRect{280, 187, 240, 106}, card(100, 0, 0));
    expect(is(l.top, 280, 131, 240, 44) && is(l.lanes, 302, 307, 218, 36), "a small map: a narrow row, the lanes still end at its right edge");
    l = card_layout(800, 480, CardRect{60, 0, 680, 300}, card(100, 0, 0));
    expect(is(l.top, 60, 0, 680, 44) && l.dy == 0, "a map at the HUD's top: the row at the top, over it");
    l = card_layout(800, 480, CardRect{60, 180, 680, 300}, card(100, 0, 0));
    expect(is(l.lanes, 522, 444, 218, 36), "a map at the HUD's bottom: the lanes at the bottom, over it");
    l = card_layout(200, 100, CardRect{0, 0, 200, 100}, card(150, 0, 0));
    expect(is(l.top, 0, 0, 200, 66) && is(l.lanes, 0, 64, 200, 36), "a target smaller than the lanes: cut to it");

    /* the map shorter while the card is on: rows cut at the top, as many at the bottom */
    expect(card_crop_rows(480, 0) == 0, "crop 0: nothing cut");
    expect(card_crop_rows(480, 20) == 48, "crop 20 % of 480: 48 rows at the top and 48 at the bottom");
    expect(card_crop_rows(480, 5) == 12 && card_crop_rows(300, 5) == 6, "always an even count (4:2:0 chroma), rounded down");
    expect(card_crop_rows(480, 90) == card_crop_rows(480, kCardCropMax), "over kCardCropMax: held to it");
    expect(kCardCropMax == 40 && kCardCropDefault == 20 && CardConfig().crop == 0, "0-40 %, 20 % by default in the configuration, none in a bare CardConfig");

    if (failures)
        return 1;
    printf("turn_card_test: ok\n");
    return 0;
}
