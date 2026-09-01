/* =========================================================================
 * Esther's staff inbox - local configuration
 *
 * HOW TO USE THIS FILE
 *   1. Copy it to  staff/config.js  (same folder, drop the ".example")
 *   2. Fill in the two placeholder values below
 *   3. Reload staff/index.html
 *
 * staff/config.js is listed in .gitignore, so your copy is never committed.
 * This example file, with placeholders only, is the one that is tracked.
 *
 * -------------------------------------------------------------------------
 * WHICH KEY GOES HERE
 *
 * ONLY the PUBLISHABLE key. It starts with:
 *
 *     sb_publishable_...
 *
 * (or, on an older project, the key labelled "anon public"). That key is
 * designed to be readable by anyone who opens the page. It is safe here
 * because it grants nothing on its own: the migrations revoke every
 * privilege from anon and authenticated, and access is decided by Row
 * Level Security plus an active row in staff_profiles.
 *
 * NEVER PUT THESE IN THIS FILE, OR IN ANY FILE THE BROWSER CAN READ:
 *
 *     sb_secret_...              the secret key
 *     the service_role key       the legacy equivalent
 *     the database password
 *     a Supabase access or refresh token
 *
 * Any of those in a browser file hands a stranger full read and write
 * access to every conversation Esther's has ever had, bypassing all of the
 * security in the migrations. They belong only in the Edge Function
 * environment, which the browser cannot see.
 *
 * If one is ever pasted into this file by mistake, treat it as leaked:
 * rotate it in the Supabase dashboard immediately. Removing it from the
 * file afterwards is not enough, and neither is deleting the commit.
 * ========================================================================= */

window.ESTHERS_CHAT_CONFIG = {
  /* Project URL, from Supabase → Project Settings → API.
     Looks like https://abcdefghijklmnop.supabase.co */
  supabaseUrl: 'PASTE_YOUR_PROJECT_URL_HERE',

  /* PUBLISHABLE key only. Never the secret key. */
  supabasePublishableKey: 'PASTE_YOUR_PUBLISHABLE_KEY_HERE',
};
