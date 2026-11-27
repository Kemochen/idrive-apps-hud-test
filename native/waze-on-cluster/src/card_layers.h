// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* The HUD turn card's image layers on the HUD feed's connection to the
 * cluster renderer: the row (or separate road and maneuver) and lanes,
 * above the map's layer in the stack, and like it contending for the HUD's
 * slot, giving way to the stock HMI's pop-ups or not, and visible only
 * while the map is. So the card never shows without the map, and never
 * keeps the HUD's slot by itself.
 *
 * The layers are there while the card is on and the HUD has a map layer.
 * A turn changes their pictures only: what differs from the picture shown
 * goes as one rectangle, and no turn is a clear picture, so a picture is
 * never shown before its pixels. A picture is drawn again only when what it
 * shows changes (a new distance leaves the lanes alone), or its size or
 * scale. A layer is made again only when its size changes (the map's width,
 * the card's size); a move sets its place. */
#ifndef WOC_CARD_LAYERS_H
#define WOC_CARD_LAYERS_H

#include <stdint.h>
#include <string>

#include "card_draw.h"
#include "cluster_render/client.h"
#include "turn_card.h"

namespace woc {

class CardLayers {
public:
    explicit CardLayers(cr::Client *client) : client_(client) {}

    void set_config(const CardConfig &c);
    /* The turn to draw; an empty one: none. */
    void set_turn(const Turn &t);
    /* The HUD map's layer: its target's size, its rect, whether it is
     * visible and gives way. tw 0: the HUD has no map layer. */
    void follow(unsigned tw, unsigned th, const CardRect &anchor, bool visible, bool yield, bool lanes_only = false);
    /* The offset the card is at: as far as it went inside the HUD once
     * placed, as asked until then. */
    int dx() const { return placed_ ? layout_.dx : cfg_.dx; }
    int dy() const { return placed_ ? layout_.dy : cfg_.dy; }
    int lanes_dx() const { return placed_ ? layout_.lanes_dx : cfg_.lanes_dx; }
    int lanes_dy() const { return placed_ ? layout_.lanes_dy : cfg_.lanes_dy; }
    int road_dx() const { return placed_ ? layout_.road_dx : cfg_.road_dx; }
    int road_dy() const { return placed_ ? layout_.road_dy : cfg_.road_dy; }
    int maneuver_dx() const { return placed_ ? layout_.maneuver_dx : cfg_.maneuver_dx; }
    int maneuver_dy() const { return placed_ ? layout_.maneuver_dy : cfg_.maneuver_dy; }
    bool owns(uint32_t ref) const { return ref && (ref == row_.ref || ref == road_.ref || ref == maneuver_.ref || ref == lanes_.ref); }
    /* The renderer refused one of its layers: no card until its settings
     * change or the HUD's map layer is made again. */
    void refused(const std::string &reason);

private:
    struct Part {
        const char *name;
        uint32_t ref = 0;
        cr::LayerOptions lo;
        CardImage shown;   /* the picture the layer has; empty: none yet */
        std::string drawn; /* what `shown` was drawn from (picture_key) */
        explicit Part(const char *n) : name(n) {}
    };
    void update();
    void place(Part *p, const CardRect &r);
    bool stale(Part *p, const std::string &key);
    void show(Part *p, CardImage m);
    void drop(Part *p);

    cr::Client *client_;
    CardConfig cfg_;
    Turn turn_;
    unsigned tw_ = 0, th_ = 0;
    CardRect anchor_;
    bool visible_ = false, yield_ = true, refused_ = false, placed_ = false, lanes_only_ = false;
    CardLayout layout_;
    Part row_{"row"}, road_{"road"}, maneuver_{"maneuver"}, lanes_{"lanes"};
};

}  // namespace woc

#endif
