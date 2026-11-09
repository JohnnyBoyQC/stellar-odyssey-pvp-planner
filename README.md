# PvP Build Planner for Stellar Odyssey

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

## Within the game's rules

The game allows scripts **for information and display only**. Both tools only read:

- the web page calls the official read-only public API with your own key;
- the userscript reads what the game page already holds. It makes **no network requests**, never clicks anything, and never acts for you.

## The meta, in short

From self-play at equal total stat, the split no build beats on average is **35% power · 15% precision · 15% evasion · 35% hull, with Block on every gear piece**. One DoT piece and three Block pieces does just as well. Stun and Focus lose at equal budget.

Total stat matters more than the split: 15% less total stat than your opponent wins about 3 duels in 100, whatever the build.

## Credits

Built from the duel simulator of the Astrolabe userscript. Unofficial: not made or endorsed by the game's developers.
