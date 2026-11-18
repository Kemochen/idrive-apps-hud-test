// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* The HUD turn card's own shapes (card_draw.cpp paints them), for the
 * arrows that are not icons (card_pick.h): keeping to a side at a fork or a
 * branch, the Y the card first had, and "follow the route", a dot. Thick
 * lines and triangles in an 80 x 80 box of units, drawn right-handed; the
 * left one is the right one mirrored. */
#ifndef WOC_CARD_SHAPES_H
#define WOC_CARD_SHAPES_H

#include <string>
#include <vector>

namespace woc {
namespace card {

struct Pt {
    float x, y;
};

/* A line through its points, `width` thick, with round bends and a round
 * end; `flat` cuts its start square (a stem's foot). One point: a dot. */
struct Line {
    std::vector<Pt> pts;
    float width;
    bool flat;
    bool dim;   /* grey: the road not taken */
};

struct Head {
    Pt a, b, c;
};

/* An arrow: its lines (grey ones first) and its head. */
struct Shape {
    std::vector<Line> lines;
    std::vector<Head> heads;
};

inline Shape mirrored(Shape s, float box_w)
{
    for (Line &l : s.lines)
        for (Pt &p : l.pts)
            p.x = box_w - p.x;
    for (Head &h : s.heads) {
        h.a.x = box_w - h.a.x;
        h.b.x = box_w - h.b.x;
        h.c.x = box_w - h.c.x;
    }
    return s;
}

const float kTurnBox = 80;

/* keep_right, keep_left, or the dot for any other name, in the 80 x 80 box. */
inline Shape turn_shape(const std::string &arrow)
{
    const float w = 10;
    Shape s;
    if (arrow == "keep_right") {
        s.lines.push_back(Line{{{40, 74}, {40, 46}, {22, 20}}, 7, true, true});
        s.lines.push_back(Line{{{40, 74}, {40, 46}, {55, 24}}, w, true, false});
        s.heads.push_back(Head{{64, 10}, {66, 31}, {44, 16}});
    } else if (arrow == "keep_left") {
        return mirrored(turn_shape("keep_right"), kTurnBox);
    } else {
        s.lines.push_back(Line{{{40, 40}}, 22, false, false});
    }
    return s;
}

}  // namespace card
}  // namespace woc

#endif
