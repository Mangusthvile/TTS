# Issue 6: Google Drive sign-in not working reliably (high priority) — Audit & implementation plan

## 1. Audit summary

**Symptom:** Google Drive sign-in sometimes fails, times out, or leaves the user stuck (e.g. “Sign in” in header but no popup, or script not loaded, or session expires without a clear path to reconnect).

**Root causes identified:** (1) **Web:** Google Identity Services (GIS) script loads **async/defer**; auth init retries for up to 10s and can show “script not loaded” or “not initialized” if the user acts before the script is ready. (2) **Web:** Popup/timeout handling has one retry for **signIn()** but **signInWithPrompt()** has no retry. (3) **Header** correctly shows orange “Sign in” when status is **expired** / **signed_out** / **error** and calls **ensureValidToken(true)** on click. (4) **Native** silent sign-in has a 15s cooldown after failure; interactive path and error handling are in place. (5) **Token validation** and 401 retry logic are sound; network errors during validation do not incorrectly expire the session.

---

## 2. Flow (traced)

### 2.1 Script and init (web)

- **index.html** loads `https://accounts.google.com/gsi/client` with **async defer**, so it may not be ready when the app runs.
- **bootstrapCore(googleClientId)** (from runStartup) calls **ensureAuthReady(clientId)** which, on web (non-native, non–Android-only), calls **authManager.init(clientId)**.
- **authManager.init(clientId)** runs **tryInit()**: if **window.google?.accounts?.oauth2** is missing, it retries every **500 ms** up to **20** times (**10 s** total). If still missing, it sets status **"error"** and lastError **"Google Sign-In script not loaded"**. If present, it creates **tokenClient** (initTokenClient) with **callback** and **error_callback**.
- **init()** returns immediately; it does not await the script. So **runStartup** can continue and later **ensureValidToken(false)** may run before **tokenClient** exists (if the script loads after the first few tryInit attempts).

### 2.2 Startup auth check

- **runStartup** (useAppBootstrap): after **bootstrapCore**, it sets “Checking session...”, then **await ensureValidToken(false)**. If that throws, **authOk = false** and **launchStage = "signin"**.
- **ensureValidToken(false)** (authManager): **getToken()**; if no token, on web it **markExpired** and throws. So expired or missing token → signin screen.

### 2.3 Header “Sign in” / reconnect

- **AppShell** receives **authStatus = authState.status**. When **authStatus** is **"expired"**, **"signed_out"**, or **"error"**, it shows the orange **Sign in** button and **onClick={onReconnectDrive}**.
- **handleReconnectDrive** (App): **await ensureValidToken(true)** then sync and “Drive reconnected.” On failure, push notice with error. So clicking **Sign in** in the header triggers **interactive** sign-in.

### 2.4 signIn() (web)

- Sets status **"signing_in"**, then starts a **15 s** timeout. If still **"signing_in"** after 15 s: **timeoutCount === 1** → wait **2 s**, then call **requestAccessToken({ prompt: "" })** again and reschedule the same timeout; **timeoutCount === 2** → set status **"error"**, lastError **"Sign-in timed out. Popup may have been blocked."**.
- Then calls **requestAccessToken({ prompt: "" })** immediately. So we get **one** automatic retry after 15s + 2s.
- If **tokenClient** is null (e.g. init not done), we set error “Google Sign-In not initialized” and call **init(clientId)** again (no await).

### 2.5 signInWithPrompt() (web)

- Sets **"signing_in"**, then a **25 s** timeout that sets **"error"** and “Sign-in timed out. Popup may have been blocked.” No retry.
- Calls **requestAccessToken({ prompt: "select_account" })**.

### 2.6 Native (Capacitor)

- **ensureAuthReady** (bootstrap) awaits **SocialLogin.initialize({ google: { webClientId, mode: "online" } })**. **authManager.init** is not used on native for creating tokenClient; **nativeSignIn** uses **SocialLogin.login**.
- **ensureValidToken(false)** calls **nativeSignIn({ interactive: false, ... })**. If that returns null, **markExpired** and throw.
- **nativeSignIn** uses **lastSilentSignInFailedAt** and **SILENT_SIGNIN_COOLDOWN_MS (15s)** so after a silent failure we skip silent for 15s to avoid repeated popups.
- Interactive **signIn()** / **signInWithPrompt()** call **nativeSignIn({ interactive: true })**. A **20 s** watchdog sets **"error"** if still **"signing_in"**.

### 2.7 Token response and validation

- **handleTokenResponse**: if **resp.error**, set status **"error"** and lastError; else update token, **saveToStorage**, **validateToken()**.
- **validateToken()**: **ensureValidToken(false)** to get token (no recursion: we already have token in state), then GET **drive/v3/about?fields=user**. **401** → **markExpired**. Other errors: do not expire (network errors), return false.
- **driveFetch** (driveAuth): on **401**, one silent **ensureValidToken(false)** and retry; if **401** again, **markExpired** and throw.

### 2.8 Settings

- When not authorized: **Connect Drive** calls **authManager.signIn()**. If **authState.lastError** is set, we show the error and **Try again (open account picker)** which calls **authManager.signInWithPrompt()**.

---

## 3. Issues list

| # | Location | What | Impact |
|---|----------|------|--------|
| 1 | **authManager.init** (web) | **tryInit** retries for max **10 s** (20 × 500 ms). On very slow networks or if the script is blocked, we can hit “Google Sign-In script not loaded” and status **"error"**. | **Medium** — User sees error; can retry by refreshing or clicking again after script loads. |
| 2 | **signIn() when tokenClient is null** | We set error “Google Sign-In not initialized” and call **init(clientId)** but don’t wait. User must click again. No “Loading…” or “Please wait” state. | **Medium** — First click after load can fail; no clear “wait for init” UX. |
| 3 | **signInWithPrompt()** (web) | **No retry**; single 25 s timeout then error. If popup is slow or user is slow, one failure ends the flow. | **Medium** — Same as signIn(), one retry would improve reliability. |
| 4 | **Header and error status** | When **authStatus === "error"**, header correctly shows orange **Sign in** and **onReconnectDrive** runs **ensureValidToken(true)**. So user can retry. | **OK** — Already correct. |
| 5 | **Native silent cooldown** | After silent sign-in failure we cooldown **15 s**. During that time **ensureValidToken(false)** returns null without trying. Interactive sign-in still works. | **Low** — By design to avoid popup spam; acceptable. |
| 6 | **validateToken** | Uses **ensureValidToken(false)** to get token; on web that just returns **getToken()** when we have a valid token. No recursion. **401** correctly expires. | **OK** — No bug. |
| 7 | **GIS error_callback** | **initTokenClient** **error_callback** sets status **"error"** and lastError (e.g. user closed popup, access_denied). User can click Sign in again. | **OK** — Handled. |
| 8 | **Launch / onStartupError** | When startup throws (e.g. restore fails), **onStartupError** can return **"ready"** when a token exists so the user is not stuck on signin. | **OK** — Already in place. |

---

## 4. In-depth implementation plan

### 4.1 Goal

- Improve reliability when the GIS script is slow or the first click happens before init completes.
- Add one retry for **signInWithPrompt()** (web) to match **signIn()**.
- Optionally surface “initializing…” so the user knows to wait instead of seeing “not initialized” on first click.

### 4.2 Strategy

- **Web:** When **signIn()** or **signInWithPrompt()** is called and **tokenClient** is null, optionally **wait** for init to complete (e.g. poll or short delay and retry) before showing “not initialized,” or show a “Loading Google Sign-In…” state.
- **Web:** Give **signInWithPrompt()** one timeout retry (like **signIn()**) so a single slow or blocked popup doesn’t end the flow.
- **Web (optional):** Increase **tryInit** retries or total wait (e.g. 30 × 500 ms = 15 s) so slow networks have more time for the script to load.
- **Native:** Keep current behaviour (cooldown, watchdog); no change required for this issue unless specific native failures are observed.

---

### 4.3 Plan items

#### P1. signInWithPrompt() retry on timeout (authManager.ts, web)

- **Where:** **signInWithPrompt()** (web path), after the **setTimeout(..., 25000)** that sets the error.
- **What:** Mirror **signIn()** logic: use a **timeoutCount** (or single retry). After the first timeout (e.g. 15 s), wait **2 s**, then call **requestAccessToken({ prompt: "select_account" })** again and schedule a second timeout (e.g. 15 s). After the second timeout set “Sign-in timed out. Popup may have been blocked.” So we get **one** retry for **signInWithPrompt()**.
- **Why:** Improves reliability when the first popup is blocked or slow; matches **signIn()** behaviour.
- **Risk:** Low.

#### P2. When tokenClient is null, wait briefly for init (authManager.ts, web)

- **Where:** **signIn()** and **signInWithPrompt()** (web), when **!this.tokenClient**.
- **What:** Instead of immediately setting error and calling **init(clientId)** and returning, **await** a short delay (e.g. 1–2 s) and re-check **this.tokenClient** (in case **tryInit** has just succeeded). If still null, then set error and call **init(clientId)**. Optionally, set status **"signing_in"** and a message like “Loading sign-in…” during the wait so the header shows “Signing In...” instead of an error.
- **Why:** Reduces “Google Sign-In not initialized” on first click when the script is still loading.
- **Risk:** Low; adds 1–2 s max wait on first click when init is slow.

#### P3. (Optional) Increase GIS init retry window (authManager.ts)

- **Where:** **tryInit()** inside **init()**, the max retry count (currently 20) or interval.
- **What:** Increase to e.g. **30** attempts (15 s total) or keep 20 but use a longer interval (e.g. 750 ms) so total wait is 15 s. Document the constant (e.g. **GIS_INIT_MAX_RETRIES = 30**, **GIS_INIT_RETRY_MS = 500**).
- **Why:** Gives slow networks or heavy pages more time for the script to load before showing “script not loaded.”
- **Risk:** Very low; only delays the error by a few seconds in the worst case.

#### P4. (Optional) Settings: show “Loading…” when init in progress (Settings.tsx / authManager)

- **Where:** Settings Drive section, when the user is not authorized.
- **What:** If we expose an “init in progress” or “client not ready” state from authManager (e.g. **status === "signing_in"** and we know init is still retrying), show “Loading Google Sign-In...” and disable the button until **tokenClient** is ready or we’ve given up. Requires authManager to expose init state or a “ready” flag.
- **Why:** Clearer UX when the script is still loading.
- **Risk:** Medium (new state to expose and wire); can be deferred.

#### P5. Trace / diagnostics (optional)

- **Where:** **authManager**: **signIn**, **signInWithPrompt**, **tryInit** (success/fail), **handleTokenResponse** (error branch).
- **What:** Ensure **trace**/traceError calls exist for timeout, retry, init failure, token error. Add one or two for “init_ready” / “signin_retry” if helpful.
- **Why:** Easier to debug “sign-in not working” in production.
- **Risk:** None.

---

### 4.4 Implementation order

1. **P1** — Add one timeout retry to **signInWithPrompt()** (web), mirroring **signIn()**.
2. **P2** — When **tokenClient** is null, wait 1–2 s and re-check before setting “not initialized” (and optionally show “Signing In...” during wait).
3. **P3** — (Optional) Increase **tryInit** retries or total wait.
4. **P4** — (Optional) Expose init-in-progress and show “Loading…” in Settings.
5. **P5** — (Optional) Add or tidy trace events.

---

### 4.5 Files to touch

| File | Changes |
|------|--------|
| **services/authManager.ts** | P1: retry logic in **signInWithPrompt()**. P2: wait-and-recheck when **tokenClient** is null in **signIn()** and **signInWithPrompt()**. P3: increase **tryInit** retries/constants. P5: trace. |
| **components/Settings.tsx** | P4 only: show “Loading…” when init in progress (if we add that state). |

---

### 4.6 Code-level sketch (P1)

**Current signInWithPrompt() (web):**
```ts
this.updateState({ status: "signing_in", lastError: undefined });
trace("auth:signin_start:with_prompt");
setTimeout(() => {
  if (this.state.status === "signing_in") {
    this.updateState({
      status: "error",
      lastError: "Sign-in timed out. Popup may have been blocked.",
    });
  }
}, 25000);
this.tokenClient.requestAccessToken({ prompt: "select_account" });
```

**After P1:** Use the same pattern as **signIn()**: a **scheduleTimeout** that on first expiry (e.g. 15 s) waits **RETRY_DELAY_MS** (2 s), then calls **requestAccessToken({ prompt: "select_account" })** again and reschedules the same timeout; on second expiry set the error. Reuse **SIGNIN_TIMEOUT_MS** and **RETRY_DELAY_MS** from **signIn()** if possible.

---

### 4.7 Code-level sketch (P2)

In **signIn()** and **signInWithPrompt()**, when **!this.tokenClient**:

```ts
if (!this.tokenClient) {
  this.updateState({ status: "signing_in", lastError: undefined });
  await new Promise((r) => setTimeout(r, 2000));
  if (!this.tokenClient) {
    this.updateState({ status: "error", lastError: "Google Sign-In not initialized" });
    if (this.clientId) this.init(this.clientId);
    return;
  }
}
// then continue with existing signing_in and requestAccessToken
```

Make **signIn()** and **signInWithPrompt()** **async** and **void this.signIn()** / **void this.signInWithPrompt()** at call sites, or keep them sync and do the wait in a **setTimeout** + re-check (no await). Prefer async/await for clarity if callers don’t need the return value.

---

## 5. Summary

- **Why sign-in can feel unreliable:** (1) **Web:** GIS script loads async; first click can happen before **tokenClient** exists → “not initialized.” (2) **Web:** **signInWithPrompt()** has no retry on timeout, so one slow/blocked popup fails. (3) **Web:** Init retries for 10 s only; slow networks can see “script not loaded.”
- **Fix:** **P1** — Add one timeout retry to **signInWithPrompt()** (same idea as **signIn()**). **P2** — When **tokenClient** is null, wait 1–2 s and re-check before showing “not initialized” (optionally show “Signing In...” during wait). **P3** (optional) — Increase **tryInit** retries or total wait. **P4** (optional) — “Loading…” in Settings when init is in progress. **P5** (optional) — Trace events for debugging.
