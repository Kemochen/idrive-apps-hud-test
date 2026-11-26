// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* The HUD's turn card: the next turn of the phone's route (or of BMW's own
 * navigation), drawn beside the HUD map from what the app reads of BMW's
 * guidance service and tells with a control {"cmd":"turn"} (control.h).
 *
 *   Example Street                 [arrow] 450 m      <- the row, over the map
 *   +----------------------------------------------+
 *   |                  the map                     |
 *   +----------------------------------------------+
 *                                    | ^ | ^ |^r>|   <- the lanes, under it
 *
 * The row is as wide as the map: the street at its left end, the arrow and
 * the distance at its right end. The lanes end at the map's right edge, so
 * the HUD's bottom left stays free for the car's own speed and limit sign.
 * Both are sized by the card's size (50 to 150 %) and moved together by its
 * offset, each held inside the HUD's scene; nothing keeps them off the map,
 * which the size and the offset are there for. */
#ifndef WOC_TURN_CARD_H
#define WOC_TURN_CARD_H

#include <stdint.h>

#include <string>

namespace woc {

/* The next turn as the app tells it (the app's turn_decode.js). */
struct Turn {
    std::string arrow;   /* straight, left, offramp_right, roundabout, arrive... (card_pick.h); empty: no turn */
    std::string exit;    /* a roundabout's exit number, or empty (logged, not drawn) */
    std::string angle;   /* a roundabout's exit, degrees clockwise from straight on (0-359), or empty */
    std::string side;    /* the side traffic drives on at a roundabout: left, right, or empty (right) */
    std::string dist;    /* "450 m", or empty */
    std::string road;    /* the street's name, or empty */
    std::string lanes;   /* "s*,s+r*,r": each lane's arrows, * on the one to take; or empty */

    bool empty() const { return arrow.empty(); }
    bool operator==(const Turn &o) const
    {
        return arrow == o.arrow && exit == o.exit && angle == o.angle && side == o.side && dist == o.dist && road == o.road &&
               lanes == o.lanes;
    }
    bool operator!=(const Turn &o) const { return !(*this == o); }
};

const unsigned kCardMinPct = 50, kCardMaxPct = 150, kCardDefaultPct = 100;
const int kCardMoveMax = 800;
/* How many lanes the card shows at most (the app sends no more). */
const unsigned kCardLanes = 6;

/* The card's settings. */
/* The HUD map shorter while the card is on, to leave room for the row and
 * the lanes: 0-40 % of its height cut, half at the top and half at the
 * bottom, the width kept (MapFeed). 20 % in the shipped configuration. */
const unsigned kCardCropMax = 40, kCardCropDefault = 20;

struct CardConfig {
    bool on = false;
    unsigned pct = kCardDefaultPct;   /* its size, % of the drawn one */
    int dx = 0, dy = 0;               /* offset from the HUD's turn-card anchor */
    unsigned crop = 0;                /* legacy linked map crop, read from older settings */
    unsigned lanes_pct = kCardDefaultPct;
    int lanes_dx = 0, lanes_dy = 0;
};

/* The rows cut at the top of a picture h rows high, and as many at the
 * bottom, for crop_pct % in all: even (4:2:0 chroma), rounded down. */
inline uint32_t card_crop_rows(uint32_t h, unsigned crop_pct)
{
    const unsigned pct = crop_pct > kCardCropMax ? kCardCropMax : crop_pct;
    return (uint32_t)(((uint64_t)h * pct / 200) & ~(uint64_t)1);
}

struct CardRect {
    int x = 0, y = 0;
    unsigned w = 0, h = 0;
};

/* Where the card's two pictures go, the size they are drawn at and the
 * offset as far as it went. */
struct CardLayout {
    CardRect top, lanes;
    float scale = 1.0f, lanes_scale = 1.0f;
    int dx = 0, dy = 0;
    int lanes_dx = 0, lanes_dy = 0;
};

namespace card_detail {

/* The design's measures at 100 %: the row's height and its gap to the map,
 * a lane's width, the lanes' height and their gap to the map. The arrow
 * and each lane's icon are the same 36 px square. */
const int kRowH = 44, kRowGap = 12, kLaneW = 36, kLanesH = 36, kLanesGap = 14;

inline int scaled(int v, float s) { return (int)(v * s + 0.5f); }
inline int held(int v, int lo, int hi) { return v < lo ? lo : v > hi ? hi : v; }

}  // namespace card_detail

/* Both anchors use a fixed reference box in HUD coordinates. */
inline CardLayout card_layout(unsigned tw, unsigned th, const CardRect &anchor, const CardConfig &c)
{
    using namespace card_detail;
    CardLayout l;
    const unsigned pct = c.pct < kCardMinPct ? kCardMinPct : c.pct > kCardMaxPct ? kCardMaxPct : c.pct;
    l.scale = pct / 100.0f;
    l.lanes_scale = held((int)c.lanes_pct, kCardMinPct, kCardMaxPct) / 100.0f;
    const int w = (int)tw, h = (int)th;

    l.top.w = anchor.w < tw ? anchor.w : tw;
    l.top.h = (unsigned)held(scaled(kRowH, l.scale), 1, h);
    const int top_x = held(anchor.x, 0, w - (int)l.top.w);
    const int top_y = held(anchor.y - scaled(kRowGap, l.scale) - (int)l.top.h, 0, h - (int)l.top.h);
    l.top.x = held(top_x + c.dx, 0, w - (int)l.top.w);
    l.top.y = held(top_y + c.dy, 0, h - (int)l.top.h);
    l.dx = l.top.x - top_x;
    l.dy = l.top.y - top_y;

    l.lanes.w = (unsigned)held(scaled(kLaneW * (int)kCardLanes + 2, l.lanes_scale), 1, w);
    l.lanes.h = (unsigned)held(scaled(kLanesH, l.lanes_scale), 1, h);
    const int max_lane_x = w - (int)l.lanes.w, max_lane_y = h - (int)l.lanes.h;
    const int lanes_x = held(anchor.x + (int)anchor.w - (int)l.lanes.w, 0, max_lane_x);
    const int lanes_y = held(anchor.y + (int)anchor.h + scaled(kLanesGap, l.lanes_scale), 0, max_lane_y);
    l.lanes.x = held(lanes_x + c.lanes_dx, 0, max_lane_x);
    l.lanes.y = held(lanes_y + c.lanes_dy, 0, max_lane_y);
    l.lanes_dx = l.lanes.x - lanes_x;
    l.lanes_dy = l.lanes.y - lanes_y;
    return l;
}

}  // namespace woc

#endif
