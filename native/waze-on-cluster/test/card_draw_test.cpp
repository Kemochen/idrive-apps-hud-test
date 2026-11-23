// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* The HUD turn card's pictures (card_draw.h): the row with the street, the
 * arrow and the distance, and the lanes. What is where and in which colour,
 * read from the pixels; the measures are the design's at 100 % (a row 44
 * high with a 36x36 arrow at its right end, lanes 36 wide and 36 high). */
#include "card_draw.h"

#include <stdio.h>
#include <stdlib.h>
#include <algorithm>
#include <string>
#include <vector>

using namespace woc;

static int failures = 0;

static void expect(bool ok, const char *what)
{
    if (!ok) {
        fprintf(stderr, "FAIL: %s\n", what);
        failures++;
    }
}

static const uint8_t *px(const CardImage &m, int x, int y) { return &m.rgba[((size_t)y * m.w + x) * 4]; }
static int alpha(const CardImage &m, int x, int y) { return px(m, x, y)[3]; }

/* Whether any pixel of x0..x1, y0..y1 (inclusive) has ink. */
static bool ink(const CardImage &m, int x0, int y0, int x1, int y1)
{
    for (int y = y0 < 0 ? 0 : y0; y <= y1 && y < (int)m.h; y++)
        for (int x = x0 < 0 ? 0 : x0; x <= x1 && x < (int)m.w; x++)
            if (alpha(m, x, y) > 24)
                return true;
    return false;
}

struct Box {
    int x0 = 1 << 30, y0 = 1 << 30, x1 = -1, y1 = -1;
};

static Box box(const CardImage &m)
{
    Box b;
    for (int y = 0; y < (int)m.h; y++)
        for (int x = 0; x < (int)m.w; x++)
            if (alpha(m, x, y) > 24) {
                b.x0 = x < b.x0 ? x : b.x0;
                b.y0 = y < b.y0 ? y : b.y0;
                b.x1 = x > b.x1 ? x : b.x1;
                b.y1 = y > b.y1 ? y : b.y1;
            }
    return b;
}

/* Solid pixels of x0..x1 that are (r, g, b), and solid ones that are not. */
static void colours(const CardImage &m, int x0, int x1, int r, int g, int b, int *same, int *other)
{
    *same = *other = 0;
    for (int y = 0; y < (int)m.h; y++)
        for (int x = x0; x <= x1; x++) {
            const uint8_t *p = px(m, x, y);
            if (p[3] < 250)
                continue;
            if (abs(p[0] - r) <= 1 && abs(p[1] - g) <= 1 && abs(p[2] - b) <= 1)
                (*same)++;
            else
                (*other)++;
        }
}

static Turn turn(const char *arrow, const char *dist = "", const char *road = "", const char *angle = "", const char *side = "")
{
    Turn t;
    t.arrow = arrow;
    t.dist = dist;
    t.road = road;
    t.angle = angle;
    t.side = side;
    return t;
}

static CardImage row(const Turn &t, float scale = 1.0f, unsigned w = 480, unsigned h = 44)
{
    CardImage m;
    draw_card_row(t, scale, w, h, &m);
    return m;
}

static CardImage lanes(const char *text, float scale = 1.0f, unsigned w = 218, unsigned h = 36)
{
    CardImage m;
    draw_card_lanes(text, scale, w, h, &m);
    return m;
}

/* a is b mirrored left to right within x0..x1. */
static bool mirrored(const CardImage &a, const CardImage &b, int x0, int x1)
{
    for (int y = 0; y < (int)a.h; y++)
        for (int x = x0; x <= x1; x++)
            if (abs(alpha(a, x, y) - alpha(b, x0 + x1 - x, y)) > 3)
                return false;
    return true;
}

/* The arrow alone is in the 36x36 square at the row's right end: x 444..479, y 4..39. */
static void the_row()
{
    CardImage m = row(Turn());
    expect(m.w == 480 && m.h == 44 && m.rgba.size() == 480u * 44 * 4, "the picture is the size asked");
    expect(!ink(m, 0, 0, 479, 43), "no turn: nothing drawn");

    const CardImage right = row(turn("right"));
    Box b = box(right);
    expect(b.x0 >= 444 && b.x1 <= 479 && b.y0 >= 4 && b.y1 <= 39, "an arrow alone is in the 36x36 square at the right end");
    expect(b.x1 >= 474, "the right turn's head points at the right edge");
    expect(alpha(right, 448, 36) >= 250 && px(right, 448, 36)[0] == 255 && px(right, 448, 36)[2] == 255,
           "its stem is solid white, left of the centre");
    expect(alpha(right, 470, 36) == 0, "and nothing is beside the stem");
    int white, other;
    colours(right, 444, 479, 255, 255, 255, &white, &other);
    expect(white > 150 && other == 0, "a plain turn is white only");

    /* the square is 444..479: a mirror image is the same square flipped */
    const struct {
        const char *left, *right;
    } pairs[] = {{"left", "right"},           {"slight_left", "slight_right"},   {"sharp_left", "sharp_right"},
                 {"uturn_left", "uturn_right"}, {"keep_left", "keep_right"},     {"offramp_left", "offramp_right"},
                 {"merge_right", "merge_left"}, {"arrive_left", "arrive_right"}};
    bool mirrors = true;
    for (const auto &p : pairs)
        mirrors = mirrors && mirrored(row(turn(p.left)), row(turn(p.right)), 444, 479);
    expect(mirrors, "each left arrow is its right one mirrored");
    expect(mirrored(row(turn("straight")), row(turn("straight")), 444, 479), "straight on is symmetric");

    const char *names[] = {"straight",      "slight_left",    "left",           "sharp_left",       "uturn_left",
                           "slight_right",  "right",          "sharp_right",    "uturn_right",      "keep_left",
                           "keep_right",    "offramp_left",   "offramp_right",  "merge_left",       "merge_right",
                           "fork3_left",    "fork3_straight", "fork3_right",    "lane_change_left", "lane_change_right",
                           "overpass",      "underpass",      "ferry",          "car_train",        "arrive",
                           "arrive_left",   "arrive_right",   "destination",    "roundabout",       "follow"};
    std::vector<CardImage> all;
    bool each = true, differ = true;
    for (const char *n : names) {
        all.push_back(row(turn(n)));
        each = each && ink(all.back(), 444, 4, 479, 39) && !ink(all.back(), 0, 0, 443, 43) && !ink(all.back(), 444, 0, 479, 3) &&
               !ink(all.back(), 444, 40, 479, 43);
        for (size_t i = 0; i + 1 < all.size(); i++)
            differ = differ && all[i].rgba != all.back().rgba;
    }
    expect(each, "every arrow draws, in its square");
    expect(differ, "and no two arrows are the same picture");
    expect(row(turn("teleport")).rgba == row(turn("follow")).rgba, "an arrow this build does not know is the dot");

    int grey;
    colours(row(turn("keep_right")), 444, 479, 255, 255, 255, &white, &other);
    colours(row(turn("keep_right")), 444, 479, 141, 147, 153, &grey, &other);
    expect(white > 80 && grey > 20, "keeping right: the way to take white, the road left grey");
    colours(row(turn("offramp_right")), 444, 479, 255, 255, 255, &white, &other);
    colours(row(turn("offramp_right")), 444, 479, 141, 147, 153, &grey, &other);
    expect(white > 80 && grey > 20, "a motorway exit: the slip road white, the motorway grey");
    b = box(row(turn("straight")));
    expect(b.x0 + b.x1 >= 922 && b.x0 + b.x1 <= 924, "straight on is centred in its square");

    const CardImage round = row(turn("roundabout", "", "", "90", "right"));
    expect(round.rgba != row(turn("roundabout", "", "", "270", "right")).rgba && round.rgba != row(turn("roundabout")).rgba,
           "a roundabout points at its exit");
    expect(mirrored(round, row(turn("roundabout", "", "", "270", "left")), 444, 479),
           "driving on the left, the same exit the other way round the ring is the mirror image");
    expect(row(turn("roundabout")).rgba == row(turn("roundabout", "", "", "0", "right")).rgba, "with no angle it points straight on");
    Turn third = turn("roundabout", "", "", "90", "right");
    third.exit = "3";
    expect(row(third).rgba == round.rgba, "its exit number is not drawn: Mapbox's roundabout has none");
}

static void the_distance()
{
    const CardImage alone = row(turn("right")), m = row(turn("right", "450 m"));
    Box b = box(m);
    expect(b.x1 >= 470, "the distance ends at the right edge");
    expect(b.x0 < 400 && b.x0 > 330, "the arrow moves left to make room for it");
    expect(!ink(m, 0, 0, 320, 43), "and nothing else is drawn");
    const int arrow_x = b.x0;
    /* the arrow's picture is the same one, moved */
    bool same = true;
    const Box a = box(alone);
    for (int y = 0; y < 44 && same; y++)
        for (int x = 0; x <= a.x1 - a.x0 && same; x++)
            same = abs(alpha(alone, a.x0 + x, y) - alpha(m, arrow_x + x, y)) <= 3;
    expect(same, "the arrow is the same beside a distance");
    const int arrow_end = arrow_x + a.x1 - a.x0;
    expect(!ink(m, arrow_end + 1, 0, arrow_end + 6, 43), "a gap between the arrow and the number");
    const Box km = box(row(turn("right", "12.5 km")));
    expect(km.x1 >= 470 && km.x0 < b.x0, "a longer distance takes more room");
    const Box bare = box(row(turn("right", "450")));
    expect(bare.x1 >= 470 && bare.x0 > b.x0, "a number with no unit is the number");
    /* the digits, 28 px, and the unit, 26 px, are centred on the row's middle */
    int top_digit = 44, bottom_digit = -1, bottom_unit = -1;
    for (int y = 43; y >= 0; y--)
        if (ink(m, arrow_end + 8, y, arrow_end + 40, y))
            top_digit = y;
    for (int y = 0; y < 44; y++) {
        if (ink(m, arrow_end + 8, y, arrow_end + 40, y))
            bottom_digit = y;
        if (ink(m, 462, y, 479, y))
            bottom_unit = y;
    }
    expect(top_digit >= 10 && top_digit <= 14 && top_digit + bottom_digit >= 42 && top_digit + bottom_digit <= 46,
           "the number is 28 px lettering in the row's middle");
    expect(bottom_unit >= bottom_digit - 1 && bottom_unit <= bottom_digit + 1, "its unit on the same line");
}

static void the_street()
{
    const Turn t = turn("right", "450 m", "Example Street");
    const CardImage none = row(turn("right", "450 m")), m = row(t);
    const int group = box(none).x0;
    Box b = box(m);
    expect(b.x0 >= 0 && b.x0 <= 4, "the street starts at the left edge");
    expect(ink(m, 0, 0, 150, 43) && !ink(m, 215, 0, group - 1, 43), "and ends where its name does");
    int top = 44, bottom = -1;
    for (int y = 0; y < 44; y++)
        if (ink(m, 0, y, 200, y)) {
            top = y < top ? y : top;
            bottom = y;
        }
    expect(top + bottom >= 36 && top + bottom <= 54 && bottom - top >= 18 && bottom - top <= 30,
           "its 26 px lettering sits in the row's middle");

    std::string longer;
    for (int i = 0; i < 12; i++)
        longer += "Example Street ";
    const CardImage cut = row(turn("right", "450 m", longer.c_str()));
    expect(box(cut).x0 == b.x0 && ink(cut, group - 60, 0, group - 17, 43), "a long name fills the room it has");
    expect(!ink(cut, group - 15, 0, group - 1, 43), "and is cut short of the arrow");
    /* cut with an ellipsis: three dots low on the line, where the full name has letters */
    int dots = -1;
    for (int x = group - 16; x > group - 60 && dots < 0; x--)
        if (ink(cut, x, 0, x, 43))
            dots = x;
    expect(dots > 0 && !ink(cut, dots - 14, 0, dots, 24) && ink(cut, dots - 14, 25, dots, 33), "with an ellipsis at its end");

    expect(ink(row(turn("right", "450 m", "K\xc3\xb6nigstra\xc3\x9f" "e")), 0, 0, 150, 43), "a name with Latin-1 letters is drawn");
    expect(row(turn("right", "450 m", "\xe5\x8c\x97\xe4\xba\xac\xe8\xb7\xaf")).rgba == none.rgba,
           "a name with a letter the lettering lacks is left out whole");
    expect(row(turn("right", "450 m", "Stra\xff\xfe")).rgba == none.rgba, "so is one that is not UTF-8");
    expect(row(turn("right", "450 m", "   ")).rgba == none.rgba, "and blanks are no name");

    const CardImage narrow = row(turn("right", "450 m", "Example Street"), 1.0f, 160, 44);
    expect(box(narrow).x0 > 20, "no room for a name: the arrow and the distance only");
    const CardImage tiny = row(turn("right", "450 m", "Example Street"), 1.0f, 100, 44);
    const Box tb = box(tiny);
    expect(tb.x0 >= 64 && tb.x1 <= 99, "no room for the distance either: the arrow only");
}

static void its_size()
{
    const Box full = box(row(turn("right"))), half = box(row(turn("right"), 0.5f, 480, 22));
    const int fw = full.x1 - full.x0 + 1, hw = half.x1 - half.x0 + 1;
    expect(hw * 2 >= fw - 3 && hw * 2 <= fw + 3 && half.x1 >= 474, "at half size the arrow is half as large, still at the right end");
    const Box big = box(row(turn("right", "450 m", "Example Street"), 1.5f, 720, 66));
    expect(big.x0 <= 6 && big.x1 >= 705 && big.y1 <= 65, "at one and a half the row fills its larger picture");
    const CardImage odd = row(turn("right", "450 m", "Example Street"), 1.0f, 479, 45);
    expect(odd.rgba.size() == 479u * 45 * 4 && box(odd).x1 >= 469, "any picture size draws");
}

/* Lanes 36 wide at the right end of 218, a dashed line before each and after the last. */
static void the_lanes()
{
    CardImage m = lanes("");
    expect(m.w == 218 && m.h == 36 && m.rgba.size() == 218u * 36 * 4 && !ink(m, 0, 0, 217, 35), "no lanes: nothing drawn");

    m = lanes("s*,s*,r");
    expect(!ink(m, 0, 0, 106, 35) && ink(m, 108, 0, 217, 35), "three lanes take the three places at the right end");
    int same, other;
    colours(m, 118, 136, 255, 255, 255, &same, &other);
    expect(same > 25 && other == 0, "a lane to take is white");
    colours(m, 154, 172, 255, 255, 255, &same, &other);
    expect(same > 25 && other == 0, "the second one too");
    colours(m, 190, 208, 107, 112, 117, &same, &other);
    expect(same > 25 && other == 0, "a lane not to take is grey");
    expect(ink(m, 108, 4, 110, 32) && ink(m, 144, 4, 146, 32) && ink(m, 216, 4, 217, 32), "lines between the lanes and at both ends");
    colours(m, 144, 146, 107, 112, 117, &same, &other);
    expect(same > 10 && other == 0, "the lines are grey");

    m = lanes("s+r*");
    int white, grey;
    colours(m, 183, 215, 255, 255, 255, &white, &other);
    colours(m, 183, 215, 107, 112, 117, &grey, &other);
    expect(white > 25 && grey > 10, "a lane of two arrows: both drawn, the one to take white, the other grey");
    expect(m.rgba != lanes("r*").rgba && m.rgba != lanes("s+r").rgba && m.rgba != lanes("s*+r").rgba,
           "and not the same as the right arrow alone, nor the lane with none or the other to take");

    const CardImage recommended = lanes("s+r+!");
    expect(px(recommended, 199, 33)[0] == 255 && alpha(recommended, 199, 33) >= 250,
           "a lane-level recommendation draws a white marker");
    const CardImage neutral = lanes("s+r");
    expect(std::equal(recommended.rgba.begin(), recommended.rgba.begin() + 30 * 218 * 4, neutral.rgba.begin()),
           "a lane-level recommendation leaves both direction glyphs neutral");

    /* a lane's place is 181..216, centred on x 199; its lines are left out */
    const struct {
        const char *left, *right;
    } pairs[] = {{"l", "r"}, {"sl*", "sr*"}, {"hl", "hr"}, {"ul", "ur"}, {"l+ul*", "r+ur*"}, {"l*+s", "s+r*"}, {"l*+r", "l+r*"}};
    bool mirrors = true;
    for (const auto &p : pairs)
        mirrors = mirrors && mirrored(lanes(p.left), lanes(p.right), 182, 215);
    expect(mirrors, "left lanes are the right ones mirrored, a left U-turn too");
    const char *codes[] = {"s", "l", "r", "sl", "sr", "hl", "hr", "ul", "ur", "s+r", "s+r*", "s*+r", "l+s+r", "-"};
    std::vector<CardImage> all;
    bool differ = true;
    for (const char *c : codes) {
        all.push_back(lanes(c));
        for (size_t i = 0; i + 1 < all.size(); i++)
            differ = differ && all[i].rgba != all.back().rgba;
    }
    expect(differ, "every lane is its own picture");
    expect(!ink(all.back(), 184, 0, 214, 35) && ink(all.back(), 216, 4, 217, 32), "a lane with no arrow is an empty place between its lines");
    expect(lanes("zz").rgba == all.back().rgba, "so is an arrow this build does not know");

    /* Mapbox's strokes end square at both ends: a turning lane's stem, a
     * line started at the bottom, stops where the straight one's does */
    const char *stems[] = {"r*", "l*", "sr*", "hr*", "ur*"};
    bool square = !ink(lanes("s*"), 182, 33, 215, 35);
    for (const char *s : stems)
        square = square && !ink(lanes(s), 182, 33, 215, 35);
    expect(square, "a stem's foot is square, not rounded below the straight one's");

    m = lanes("s,s,s,s,s,s,r*,r*");
    expect(ink(m, 0, 4, 3, 32) && lanes("s,s,s,s,s,s").rgba == m.rgba, "more than six lanes: the first six");
    const Box half = box(lanes("s*,r", 0.5f, 109, 18));
    expect(half.x0 >= 109 - 38 && half.x0 <= 109 - 36 && half.x1 >= 107, "at half size two lanes are 18 wide each");
}

int main()
{
    the_row();
    the_distance();
    the_street();
    its_size();
    the_lanes();
    if (failures)
        return 1;
    printf("card_draw_test: ok\n");
    return 0;
}
