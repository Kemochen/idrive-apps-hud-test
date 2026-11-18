// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/* Host test of the app's notes (app_note.h): a note as one log line, its
 * control characters as spaces and cut to kNoteMax bytes, never half a
 * UTF-8 character; at most kNotesPerMinute a minute, the ones over counted
 * and said once when the next minute starts. */
#include <cstdio>
#include <string>

#include "app_note.h"

using namespace woc;

static int failures;

static void ok(const char *name, bool cond)
{
    std::printf("%-4s %s\n", cond ? "ok" : "FAIL", name);
    if (!cond) failures++;
}

int main()
{
    ok("plain text: kept", note_text("lanes guidance: {\"rows\":[]}") == "lanes guidance: {\"rows\":[]}");
    ok("control characters: spaces, one line", note_text(std::string("a\nb\tc\x7f" "d\x01", 8)) == "a b c d ");
    ok("over kNoteMax bytes: cut to it", note_text(std::string(kNoteMax + 50, 'x')) == std::string(kNoteMax, 'x'));
    {
        const std::string s = std::string(kNoteMax - 1, 'a') + "\xc3\xa9";  /* e acute across the cut */
        ok("a UTF-8 character across the cut: left out whole", note_text(s) == std::string(kNoteMax - 1, 'a'));
    }
    ok("UTF-8 inside the limit: kept", note_text("Stra\xc3\x9f" "e") == "Stra\xc3\x9f" "e");
    {
        NoteLimit l;
        unsigned dropped = 99;
        bool all = true;
        for (unsigned i = 0; i < kNotesPerMinute; i++)
            all = all && l.take(1000 + i, &dropped) && dropped == 0;
        ok("up to kNotesPerMinute in a minute: taken", all);
        ok("one more in the same minute: not taken", !l.take(2000, &dropped) && !l.take(30000, &dropped));
        ok("the next minute: taken, the two dropped said once",
           l.take(1000 + kNoteWindowMs, &dropped) && dropped == 2 && l.take(1001 + kNoteWindowMs, &dropped) && dropped == 0);
    }
    {
        NoteLimit l;
        unsigned dropped = 99;
        ok("a clock that goes back: a new minute, not a lock-out",
           l.take(100000, &dropped) && l.take(50, &dropped) && dropped == 0);
    }
    std::printf("%s\n", failures ? "FAILED" : "all passed");
    return failures ? 1 : 0;
}
