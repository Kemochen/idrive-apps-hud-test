// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
#include "map_state.h"

#include <unistd.h>

#include <algorithm>
#include <cstdlib>
#include <fstream>
#include <iterator>

#include "log.h"

namespace woc {

const char *const kMapStateKeys[22] = {"cluster",      "hud",            "hud_width_pct",  "hud_offset_x",
                                       "hud_offset_y", "hud_keep_shown", "hud_hide_sport", "hud_card",
                                       "hud_card_pct", "hud_card_x",     "hud_card_y",     "hud_card_crop", "adaptive_hud",
                                       "hud_map_crop", "hud_map_zoom",   "hud_lanes_pct",  "hud_lanes_x", "hud_lanes_y",
                                       "hud_road_x", "hud_road_y", "hud_maneuver_x", "hud_maneuver_y"};

namespace {

std::string trim(const std::string &s)
{
    const size_t a = s.find_first_not_of(" \t\r"), b = s.find_last_not_of(" \t\r");
    return a == std::string::npos ? "" : s.substr(a, b - a + 1);
}

/* A whole number in the key's range: the map on (1) or off (0), 0 or 20-100 %
 * wide, -800..800 px from the centre, kept shown (1) or not (0), hidden in a
 * Sport mode (1) or not (0), the turn card on (1) or off (0), 50-150 % of its
 * size, -800..800 px from its place, 0-40 % of the map's height cut while
 * it is on. */
bool valid(const std::string &key, const std::string &value)
{
    char *end = nullptr;
    const long v = std::strtol(value.c_str(), &end, 10);
    if (value.empty() || *end)
        return false;
    if (key == "hud_width_pct")
        return v == 0 || (v >= 20 && v <= 100);
    if (key == "hud_offset_x" || key == "hud_offset_y" || key == "hud_card_x" || key == "hud_card_y" ||
        key == "hud_road_x" || key == "hud_road_y" || key == "hud_maneuver_x" || key == "hud_maneuver_y" ||
        key == "hud_lanes_x" || key == "hud_lanes_y")
        return v >= -800 && v <= 800;
    if (key == "hud_card_pct" || key == "hud_lanes_pct")
        return v >= 50 && v <= 150;
    if (key == "hud_card_crop" || key == "hud_map_crop")
        return v >= 0 && v <= 40;
    if (key == "hud_map_zoom")
        return v >= 100 && v <= 150;
    return v == 0 || v == 1;
}

}  // namespace

void load_map_state(cld::Config *cfg, const std::string &path)
{
    if (path.empty() || access(path.c_str(), F_OK) != 0)
        return;
    std::ifstream f(path);
    if (!f) {
        log_warn("%s: cannot read it: the map settings of the configuration instead", path.c_str());
        return;
    }
    std::string line, applied, err;
    while (std::getline(f, line)) {
        if (trim(line).empty())
            continue;
        const size_t eq = line.find('=');
        const std::string key = trim(line.substr(0, eq)), value = eq == std::string::npos ? "" : trim(line.substr(eq + 1));
        const bool known = std::find_if(std::begin(kMapStateKeys), std::end(kMapStateKeys),
                                        [&](const char *k) { return key == k; }) != std::end(kMapStateKeys);
        if (!known || !valid(key, value) || !cfg->set_pair(key + "=" + value, &err)) {
            log_warn("%s: \"%s\" left out", path.c_str(), trim(line).c_str());
            continue;
        }
        applied += (applied.empty() ? "" : ", ") + key + " " + value;
    }
    if (!applied.empty())
        log_info("map settings from %s: %s", path.c_str(), applied.c_str());
}

}  // namespace woc
