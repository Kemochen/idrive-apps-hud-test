// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
#include "card_pick.h"

#include <stdio.h>
#include <stdlib.h>

#include <algorithm>
#include <vector>

namespace woc {
namespace card {

namespace {

Pick named(const char *name, bool mirror = false)
{
    Pick p;
    p.icon = find_icon(name);
    p.mirror = p.icon && mirror;
    return p;
}

/* A right-handed icon for name_right, mirrored for name_left. */
bool sided(const std::string &arrow, const char *base, const char *icon, Pick *out)
{
    const std::string b(base);
    if (arrow == b + "_right")
        *out = named(icon);
    else if (arrow == b + "_left")
        *out = named(icon, true);
    else
        return false;
    return true;
}

/* A lane's arrow letters, Mapbox's way: its kind, and which side. */
struct Arrow {
    std::string code;
    const char *kind;   /* straight, slight turn, turn, sharp turn, uturn */
    int side;           /* -1 left, 0 straight, 1 right */
};

bool arrow_of(const std::string &code, Arrow *out)
{
    static const struct {
        const char *code, *kind;
        int side;
    } kArrows[] = {{"s", "straight", 0},      {"sl", "slight_turn", -1}, {"l", "turn", -1},  {"hl", "sharp_turn", -1},
                   {"ul", "uturn", -1},       {"sr", "slight_turn", 1},  {"r", "turn", 1},   {"hr", "sharp_turn", 1},
                   {"ur", "uturn", 1}};
    for (const auto &a : kArrows)
        if (code == a.code) {
            *out = Arrow{code, a.kind, a.side};
            return true;
        }
    return false;
}

/* Mapbox's order of a lane's indications in a drawing's name. */
int rank(const std::string &name)
{
    static const char *kOrder[] = {"opposite_uturn", "opposite_sharp_turn", "opposite_turn", "opposite_slight_turn", "straight",
                                   "slight_turn",    "turn",                "sharp_turn",    "uturn"};
    for (int i = 0; i < 9; i++)
        if (name == kOrder[i])
            return i;
    return 9;
}

}  // namespace

int roundabout_angle(const std::string &exit_angle, const std::string &side)
{
    char *end = nullptr;
    const long a = exit_angle.empty() ? -1 : strtol(exit_angle.c_str(), &end, 10);
    if (a < 0 || a > 359 || (end && *end))
        return 180;
    long m = side == "left" ? a - 180 : 180 - a;
    m = ((m % 360) + 360) % 360;
    if (m == 0)
        m = 360;   /* back the way it came: all the way round */
    m = (m + 2) / 5 * 5;
    return (int)std::min(340L, std::max(20L, m));
}

Pick turn_icon(const Turn &t)
{
    const std::string &a = t.arrow;
    Pick p;
    if (a == "straight")
        return named("arrow_straight");
    if (sided(a, "slight", "arrow_slight_right", &p) || sided(a, "sharp", "arrow_sharp_right", &p) ||
        sided(a, "uturn", "arrow_uturn_right", &p) || sided(a, "offramp", "offramp", &p) ||
        sided(a, "arrive", "arrive_right", &p))
        return p;
    if (a == "right" || a == "left")
        return named("arrow_right", a == "left");
    /* Mapbox's merge comes in from the left */
    if (a == "merge_left" || a == "merge_right")
        return named("merge", a == "merge_right");
    if (a == "roundabout") {
        char name[24];
        snprintf(name, sizeof name, "roundabout_%d", roundabout_angle(t.angle, t.side));
        return named(name, t.side == "left");
    }
    static const char *kOwn[] = {"arrive",     "destination",       "fork3_left",        "fork3_straight", "fork3_right",
                                 "overpass",   "underpass",         "ferry",             "car_train",      "lane_change_left",
                                 "lane_change_right"};
    for (const char *n : kOwn)
        if (a == n)
            return named(n);
    return p;
}

Pick lane_icon(const std::string &lane)
{
    /* its arrows, each once, and the one to take */
    std::vector<Arrow> arrows;
    std::string valid;
    for (size_t at = 0; at <= lane.size();) {
        const size_t plus = std::min(lane.find('+', at), lane.size());
        std::string code = lane.substr(at, plus - at);
        at = plus + 1;
        const bool take = !code.empty() && code.back() == '*';
        if (take)
            code.pop_back();
        Arrow a;
        if (!arrow_of(code, &a))
            continue;
        if (take && valid.empty())
            valid = code;
        if (std::none_of(arrows.begin(), arrows.end(), [&](const Arrow &x) { return x.code == code; }))
            arrows.push_back(a);
    }
    if (arrows.empty())
        return Pick();

    const auto is = [&](int side) {
        return std::any_of(arrows.begin(), arrows.end(), [&](const Arrow &x) { return x.side == side; });
    };
    Arrow taken{"", "", 0};
    for (const Arrow &x : arrows)
        if (x.code == valid)
            taken = x;
    /* both sides: "opposite" on the side not taken, facing the one taken */
    bool flipped = false;
    int opposite = 0;
    if (is(-1) && is(1)) {
        flipped = taken.side == -1;
        opposite = flipped ? 1 : -1;
    } else if (is(-1)) {
        flipped = true;
    }
    struct Named {
        std::string name, code;
    };
    std::vector<Named> names;
    for (const Arrow &x : arrows)
        names.push_back(Named{(x.side != 0 && x.side == opposite ? "opposite_" : "") + std::string(x.kind), x.code});
    const auto by_rank = [](const Named &a, const Named &b) { return rank(a.name) < rank(b.name); };
    std::stable_sort(names.begin(), names.end(), by_rank);
    if (names.size() > 3) {
        /* the one to take and the first two others */
        std::vector<Named> kept;
        for (const Named &n : names)
            if (n.code == valid)
                kept.push_back(n);
        for (const Named &n : names)
            if (n.code != valid && kept.size() < 3)
                kept.push_back(n);
        std::stable_sort(kept.begin(), kept.end(), by_rank);
        names = kept;
    }
    std::string valid_name;
    std::string name = "lane";
    for (size_t i = 0; i < names.size(); i++) {
        name += (i ? "_or_" : "_") + names[i].name;
        if (names[i].code == valid)
            valid_name = names[i].name;
    }
    if (!valid_name.empty())
        name += "_using_" + valid_name;
    Pick p = named(name.c_str(), flipped);
    if (!p.icon) {
        /* no drawing of that mix: the arrow to take alone, or a grey straight one */
        if (!valid_name.empty())
            p = named(("lane_" + valid_name + "_using_" + valid_name).c_str(), flipped);
        else
            p = named("lane_straight");
    }
    return p;
}

}  // namespace card
}  // namespace woc
