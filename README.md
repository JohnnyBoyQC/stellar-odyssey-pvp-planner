# PvP Build Planner for Stellar Odyssey (beta)

A fan-made arena build planner for Stellar Odyssey. It shows the meta stat split at **your own** total stat, the best free re-spec of your build, and which gear upgrades are worth buying.

Two ways to use it:

## 1. Web page: nothing to install

**➜ [Open the planner](https://johnnyboyqc.github.io/stellar-odyssey-pvp-planner/)**

1. In the game, open **Profile › Game API** and copy your API key.
2. Pick your realm (Steam or Web), paste the key, and click **Load my build**.
3. Read the **Current**, **Best build** and **Upgrades** tabs.

Not ready to paste a key? Click **Try with sample data**.

- Your key goes **only** from your browser to the game's official read-only API. It is stored on your device only if you tick *Remember key*.
- Each load uses 1 of your 50 daily calls to `/user`. Loading again within 30 minutes reuses the last answer, free.
- The API has no duel history, so the page scores builds against the simulated meta field. The userscript below also learns from your real duels.

## 2. Userscript: inside the game, learns from your duels

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. **➜ [Install PvP Meta](https://raw.githubusercontent.com/JohnnyBoyQC/stellar-odyssey-pvp-planner/main/pvp-meta.user.js)**. Tampermonkey opens an install page.
3. Open the game. A **⚔ PvP Meta** button appears and can be dragged anywhere.

It records arena duels you fight or open (Battlefield › Battle Log › Arena). After 8 duels, it plans against your real opponents instead of the meta field.

**Battle archive (1.1):** as you browse, it also keeps the squadron battles in your Battle Log (with their full fight logs), arena duels you open, your Squadron Groups and the map, in your own browser. Set the squadron log to 50 per page and click through the pages once to keep them all. This is the groundwork for the squadron simulator and group builder that come next. ⚙ › Battle archive shows what's kept and lets you download or clear it.

## Plan against a real player or squadron (1.2)

With the userscript installed, open **⚔ PvP Meta** in the game and click **Open in planner ↗**. The planner opens in a new tab with your build, your arena duels and one card per player seen in your squadron battles. No API key is needed for this.

- Under **Plan against**, pick the meta field, all your recorded duels, **one player**, or **one squadron**. The Current, Best build and Upgrades tabs then answer for that choice.
- Damage, health, clones, crit and dual shot are exact (the game sends them in every squadron battle). Precision, evasion and skills are estimated from how the swings went, with the doubt shown as ±; the plan takes that doubt into account.
- Open **Squadron Groups** in the game once, so your own members' stats are known: that is what the estimates are measured against.
- The data travels inside the link after `#`, which browsers never send to any server, and is then kept only in your browser. You can also load the file from ⚙ › Battle archive › Download with **Load archive file**.

## No install: the PvP Planner button (1.4)

Players without the script can still bring in their own battles. On the page, open **No script? Use the PvP Planner button**, drag **⚔ PvP Planner** to the bookmarks bar, click it on the game page, browse the Battle Log, Squadron Groups and the arena duels you want, then click **Send to planner** in the little box. Like the script it only reads what the game shows; it lasts until the game tab is reloaded. (In a web browser, not inside the Steam app.)

## Languages (1.4)

English, Español and 中文, the game's three languages, with the game's own words for stats, skills and menus. The page follows the browser's language; the picker at the top changes it.

## Squadron group builder (1.3)

Under **Squadron groups** the page shows your squadron's roster exactly as Squadron Groups sent it (stats, gear level/tier, clones, Velari, active), and the enemy groups met in your battles, with their members in fight order.

- Untick whoever won't be there, tick up to 3 enemy groups, and click **Build the best groups**. It tries swaps and every fight order, and fights each pairing in the squadron simulator (a relay: one member per side at a time, defender first, kill debuff), half attacking and half defending.
- You get the suggested groups in fight order, a win-chance table against each enemy group (and the same table for your current groups), each with an error bar, and plain text to paste in chat.
- Changing groups stays something you do yourself in the game.

**No script?** Someone who has PvP Meta clicks **Save a share file** and posts it in the squadron chat; anyone can load it with **Load file**. It holds the player cards, enemy groups and roster, not the sharer's build or duels. Your own arena duels still need the script.

## What changed

- **1.4** (page): How to use section, the PvP Planner button (no install), Spanish and Chinese.
- **1.4.1** (page) and **1.3.1** (script): Best build now tunes the stat split with simulated fights. Before, it always came out near an even 26/24/24/26.
- **1.4.2** (page) and **1.3.2** (script): stats and skills are tested together: each skill set gets its own tuned split.
- **1.4.3** (page): team builder in Squadron groups: pick who fights in each place of each group, test it against the enemy groups, compare with your groups as they are now.
- **1.4.4** (page): the team builder is laid out like the game's Squadron Groups page: three groups with totals, a member picker, member cards with position, stats and remove.
- **1.4.5** (page): everything loaded with the PvP Planner button or from a file is saved in the browser and each new load adds to it (no need to load old logs again). Download saved data gives it as a file.
- **1.4.6** (page) and **1.3.3** (script): click a player to see their estimated build (stats with ±, skills, clones, dates). Player list shows the last fight (orange after 7 days) and since when their build is the same.
- **1.4.7** (page) and **1.3.4** (script): hidden build changes (points moved between precision and evasion, or skills swapped) are found from the fights and only the fights after the change are used.
- **1.4.8** (page) and **1.3.5** (script): fixes from a full review (Astra and Fable): hidden-change check no longer blames enemies for our own upgrades, Best build keeps your gear stats when changing them gains nothing, old duels keep the stats you had then, enemy stat draws fixed, squadron chances shown attacking/defending, Test this team follows Plays, wiki end rules (kills first, health left) and the 100 floor, honest share-file text, safer saving.
- **1.4.9** (page) and **1.3.6** (script): squadron data for everyone. Publish for my squadron makes one file locked with a squad password; once it is in the `shared/` folder of this repository, everyone who opens the page and knows the password gets those battles, rosters and duels. The script now also sends its raw battles so all imports add up.
- **1.3** (script and page): squadron group builder with a 3x3 win table, share file for players without the script, squadron simulator. The duel recorder now counts a hit that kills with a DoT tick.
- **1.2** (script and page): Open in planner, player and squadron picker, new arena duels keep the opponent's name, dark theme by default, beta label.
- **1.1** (script and page): the duel engine follows rules measured on real fight logs. DoT is applied before the block roll. A dual shot is one swing on one target, and its second shot needs its own hit and block. Damage is rounded down. The duel recorder now reads dual shots and crit damage correctly (older versions mistook dual shots for crits). Plus the battle archive above.
- **1.0**: first release.

## Within the game's rules

The game allows scripts **for information and display only**. Both tools only read:

- the web page calls the official read-only public API with your own key;
- the userscript reads what the game page already holds, including copies of the answers the game itself receives. It makes **no network requests**, never clicks anything, never pages through logs, and never acts for you.

## The meta, in short

From self-play at equal total stat, the split no build beats on average is **35% power · 15% precision · 15% evasion · 35% hull, with Block on every gear piece**. One DoT piece and three Block pieces does just as well. Stun and Focus lose at equal budget.

Total stat matters more than the split: 15% less total stat than your opponent wins about 3 duels in 100, whatever the build.

## Credits

Built from the duel simulator of the Astrolabe userscript. Unofficial: not made or endorsed by the game's developers.
