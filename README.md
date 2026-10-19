# Science Bowl Tracker

Practice stat tracker for selecting a National Science Bowl team. Hosted on GitHub Pages, data in Firestore.

## Running a practice
1. **Setup:** date, group, question set, round, then tap who's here.
2. **Lineup:** *Auto-seat* fills both teams with the players who have played the fewest tossups today. Change any seat between tossups; stats stay with whoever earned them.
3. **Each tossup:** pick the category (or press B/C/E/N/M/P), then mark the buzz:
   - **✓** correct (+4) opens that team's bonus: **Y** correct (+10) / **X** missed.
   - **Neg** = interrupted and wrong: the other team gets +4 and can buzz on the rebound.
   - **✗** = wrong after the question was finished (no penalty); the other team can still buzz.
   - **D** = dead tossup. After both teams miss, it moves on by itself.
   - Tap bench players who **wrote** the right answer.
   - **U** undoes anything.
4. **End & save match.** An unsaved match survives a page refresh.

## Stats
- **Leaderboard:** Pts / 10 TU (tossup points per 10 tossups heard while seated), accuracy, neg %, buzz %, bench written accuracy. Click columns to sort; export to CSV.
- **Categories:** estimated chance each player knows a tossup in each category (seated correct + bench written), adjusted for small samples.
- **Team Builder:** finds the 4 starters with the best combined category coverage, plus the best alternate. Lock or exclude players.
- **History:** every match tossup by tossup; delete mistakes.
- **Roster:** bulk add (`Last, First, Grade`), set grade, mark inactive.
