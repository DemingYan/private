# Card Offer Clickers

Tampermonkey userscripts for adding card offers by clicking each issuer's native UI.

## Scripts

- `AmexNativeOfferClicker.user.js`: Amex Offers helper.
- `ChaseOfferClicker.user.js`: Chase Offers helper for the currently loaded Chase Offers page.
- `FidelityFullViewRefresher.user.js`: Fidelity Full View helper for refreshing linked institutions.

## Why this script exists

The direct enrollment API can hit CORS or 429 errors. The safer approach is to click the same native Amex offer buttons a person would click.

Important lessons from testing:

- Use each card's `opaqueAccountId`, not the stale card state currently shown in the page.
- After a card appears done, reload the same Offers URL and check again.
- Amex can lazy-load more offers after refresh.
- Skip checking accounts. Only process credit cards.
- A slower delay is safer. `5000ms` is a good default; `7000ms` is better after rate-limit errors.
- Amex can time out during long runs. Keep-alive is enabled by default and sends light page activity every few minutes.
- The floating panel uses low-frequency cached status updates so it does not keep scanning the whole Amex page.

## Usage

1. Install `AmexNativeOfferClicker.user.js` in Tampermonkey.
2. Open any `global.americanexpress.com` dashboard or offers page.
3. Use the floating `Amex Native Offers` panel.
4. Click `Scan Cards` to confirm detected cards.
5. Click `Add All Cards` to process all detected credit cards.
6. Leave `Keep Alive On` enabled for long runs. The default interval is `4` minutes.

The script runs card by card:

1. Open `/offers?opaqueAccountId=...`
2. Click visible native `+` buttons slowly.
3. Reload the same page.
4. Continue if more offers appear.
5. Move to the next card only after a refresh shows no more add buttons.

## Keep-alive

The panel includes a `Keep Alive On/Off` button and an interval input in minutes.

When enabled, the script periodically sends light activity to the page. If Amex shows a session prompt such as `Stay logged in` or `Continue session`, the script clicks it.

## Notes

These scripts do not make purchases or payments. They only add available offers through the visible issuer UI.

## Chase Usage

1. Install `ChaseOfferClicker.user.js` in Tampermonkey.
2. Open the Chase Offers page for the card/account you want to process.
3. Use the floating `Chase Offers` panel.
4. Click `Add Loaded Offers`.
5. To run across cards, click `Add All Cards`. The script opens account overview, scans Chase account IDs, then tries each Offers Hub.

The Chase script is intentionally conservative:

- It does not call Chase private APIs.
- It only clicks visible Chase Offers Hub tiles marked `Add offer`.
- It skips tiles already marked `Success Added`.
- It scrolls slowly to load more offers.
- It reloads once to verify whether more addable offers appear.
- It shows a timeout warning when Chase has logged out.
- `Debug Scan` logs the offer-like controls it can see without clicking them.
- `Scan Cards` stores account ID candidates found on the current Chase overview page.

## Fidelity Full View Usage

1. Install `FidelityFullViewRefresher.user.js` in Tampermonkey.
2. Open Fidelity Full View Net Worth or `Edit accounts`.
3. Click `Refresh All`; it will open `Edit accounts` if needed.
4. Optional: click `Scan Institutions` first to preview the detected institutions.

The Fidelity script is intentionally UI-only:

- It does not call Fidelity or aggregation APIs directly.
- It scans visible linked institution cards.
- It ignores individual account rows and only opens institution cards.
- It opens each institution, clicks the native `Refresh information` control, waits, then clicks `Back`.
- If Fidelity asks for credentials, MFA, or manual repair, the script stops so you can handle it.
