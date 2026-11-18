// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* The app's notes, {"cmd":"note","text":...} (control.h): a line the app
 * wants in this tool's log, the one Save logs collects, since the app's own
 * log is not in it. The turn card's lane reads use it (the app's
 * turn_guide.js). A note is one line, its control characters as spaces, at
 * most kNoteMax bytes, never half a UTF-8 character; at most
 * kNotesPerMinute a minute are logged, and the ones over are counted and
 * said once when the next minute starts, so an app cannot flood the log. */
#ifndef WOC_APP_NOTE_H
#define WOC_APP_NOTE_H

#include <cstddef>
#include <cstdint>
#include <string>

namespace woc {

const size_t kNoteMax = 400;
const unsigned kNotesPerMinute = 30;
const int64_t kNoteWindowMs = 60000;

/* text as one log line's: control characters as spaces, cut to kNoteMax
 * bytes at a character's start. */
inline std::string note_text(const std::string &text)
{
    std::string s = text;
    if (s.size() > kNoteMax) {
        size_t cut = kNoteMax;
        /* back to the start of the character the cut falls in */
        while (cut > 0 && (static_cast<unsigned char>(s[cut]) & 0xc0) == 0x80)
            cut--;
        s.resize(cut);
    }
    for (char &c : s) {
        const unsigned char u = static_cast<unsigned char>(c);
        if (u < 0x20 || u == 0x7f)
            c = ' ';
    }
    return s;
}

/* At most kNotesPerMinute notes in a minute, the minute starting with its
 * first note. */
class NoteLimit {
public:
    /* Whether a note at now_ms is logged. *dropped is the count of notes
     * not logged in the minute before, given once as a new minute starts,
     * else 0. A clock that goes back starts a new minute. */
    bool take(int64_t now_ms, unsigned *dropped)
    {
        *dropped = 0;
        if (count_ == 0 || now_ms < start_ || now_ms - start_ >= kNoteWindowMs) {
            *dropped = dropped_;
            dropped_ = 0;
            start_ = now_ms;
            count_ = 0;
        }
        if (count_ >= kNotesPerMinute) {
            dropped_++;
            return false;
        }
        count_++;
        return true;
    }

private:
    int64_t start_ = 0;
    unsigned count_ = 0;
    unsigned dropped_ = 0;
};

}  // namespace woc

#endif
