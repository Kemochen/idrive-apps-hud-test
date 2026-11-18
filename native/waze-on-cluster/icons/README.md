# The HUD turn card's icons

`src/card_icons.cpp` is made from these by `tools/bake_card_icons.py`
(`src/card_icons.h` says what it holds, `src/card_pick.h` which icon a turn
or a lane draws). They were picked one by one in the turn card's review, and
are used as drawn, but for the changes listed here.

## Mapbox's turn arrows and lanes (CC0 1.0)

From [mapbox/navigation-ui-resources](https://github.com/mapbox/navigation-ui-resources)
at commit `b811dec634516ccb8e0d2d3b34a0f0c70f996e97`, which Mapbox has
dedicated to the public domain (CC0 1.0, its `LICENSE.md`). The PaintCode
documents are read as they are and not kept here:

| File | SHA-256 |
|---|---|
| `Maneuvers.pcvd` | `825e256f6d5aaac50da61bd9195a3b7b0338fb78ee71fa4fc17b5eddc28a79d3` |
| `Lanes.pcvd` | `37538e0683f8743fd6b21b29f7131d7b1ad2675004b711b8cc233cc44d117f2f` |

    python3 tools/bake_card_icons.py --maneuvers Maneuvers.pcvd --lanes Lanes.pcvd > src/card_icons.cpp

Changed: the turn arrows' heads (not the lanes') are drawn at 60 % of
Mapbox's, the stem kept; the roundabout is baked every 5 degrees from 20 to
340. Which lane drawing a lane gets follows Mapbox's own rules
(`docs/lanes.md` there).

Mapbox's iOS SDK has the same drawings as generated Swift, under Mapbox's
terms of service: nothing here comes from it.

## Other icons, kept here

| File | Source | Licence | For |
|---|---|---|---|
| `osmand_3way_take_left.svg`, `osmand_3way_take_straight.svg`, `osmand_3way_take_right.svg` | OsmAnd's lane arrow for three directions, transcribed from [TurnPathHelper.java](https://github.com/osmandapp/OsmAnd/blob/4ea06e7074be5b6bc4c620d7ca0f7a935319152d/OsmAnd/src/net/osmand/plus/views/TurnPathHelper.java) (colours from `LanesDrawable.java`) | GPL-3.0-or-later | three-way forks |
| `osmand_keep_left.svg`, `osmand_keep_right.svg` | OsmAnd's keep left / right (TurnType KL, KR), from the same file | GPL-3.0-or-later | lane changes |
| `material_flyover.svg` | Material Symbols `flyover`, outlined, [google/material-design-icons](https://github.com/google/material-design-icons/blob/10ecc14790612ca8fd164e3f4ffe9c16fc50d5b7/symbols/web/flyover/materialsymbolsoutlined/flyover_24px.svg) | Apache-2.0 (`LICENSES/Apache-2.0.txt`) | overpasses |
| `material_directions_boat.svg`, `material_train.svg` | Material Symbols `directions_boat` and `train`, outlined, same repository | Apache-2.0 | ferries, car trains |
| `maki_tunnel.svg` | Maki `tunnel`, [mapbox/maki](https://github.com/mapbox/maki/tree/28e2a3602e4bde033a1dd388e86e9c117b425e34/icons) | CC0 1.0 | underpasses |

Changed: each is fitted into the card's 32-unit box as the review showed
it (the pictograms smaller than the box, as the arrows' heads leave room);
OsmAnd's grey is the card's grey.
