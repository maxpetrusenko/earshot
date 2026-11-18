/**
 * Styles for the reference-style explain page. Light only, phone-first. Local font faces with fallbacks:
 * the Orca frame has no network access, so nothing is fetched. Text and tint pairs are AA at body size.
 */
const SANS = `"Avenir Next","Gill Sans","Source Sans 3","Segoe UI","Trebuchet MS",sans-serif`;
const MONO = `"SF Mono","Menlo","Consolas","Liberation Mono",monospace`;

export const CARDS_CSS = `*{box-sizing:border-box}
:root{--ink:#14201d;--mute:#445049;--line:#cfd6cf;--card:#fff;--bg:#f2f5ef;--eye:#35574a;--bad:#9b3524;--badbg:#ffece6;--good:#0d6648;--goodbg:#e4f3ea;--blue:#1b4f9f;--blueMute:#4d5d7a;--chip:#d9e5fb}
body.k-state_key{--bg:#f6f3ec;--eye:#5a4a2c}
body.k-range_chart{--bg:#edf1f9;--eye:#37507c;--ink:#16223a;--mute:#3f4c66;--line:#c9d3e6}
body.k-architecture{--bg:#f3f4f6;--eye:#3b4a5e;--line:#cfd4dc}
html{background:var(--bg);min-height:100%}
body{margin:0;font-family:${SANS};font-size:16px;line-height:1.35;color:var(--ink);background:radial-gradient(520px 260px at 100% 0,rgba(255,255,255,.7),transparent 70%),var(--bg);min-height:100vh}
.pg{max-width:560px;margin:0 auto;padding:24px 22px 26px}
.ey{margin:0 0 14px;font-size:14px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--eye)}
.ey span,.ct span{opacity:.7;margin:0 3px}
h1{margin:0 0 8px;font-size:32px;line-height:1.08;font-weight:800;letter-spacing:-.02em}
.sb{text-wrap:balance;margin:0 0 20px;font-size:19px;line-height:1.3;color:var(--mute)}
.cd{background:var(--card);border:1.5px solid var(--line);border-radius:18px;padding:13px 14px 14px;margin:0 0 12px}
.ct{margin:0 0 8px;font-size:14px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--mute)}
.mono{margin:0 0 10px;padding:12px 12px;border-radius:10px;font-family:${MONO};font-size:22px;line-height:1.2;font-weight:700;overflow-wrap:anywhere;background:#eef1ee}
.st{margin:2px 0 14px;font-size:27px;line-height:1.15;font-weight:800;letter-spacing:-.01em}
.cc{margin:0;font-size:16px;color:var(--mute)}
.t-bad .ct{color:var(--bad)}.t-bad .mono{background:var(--badbg);color:var(--bad)}
.t-good .ct{color:var(--good)}.t-good .mono{background:var(--goodbg);color:var(--good)}
.mk{display:flex;align-items:center;gap:3px;height:38px;padding:0 10px;border-radius:9px;background:#eef1ee;margin:0 0 4px}
.mk.dash{gap:6px}
.mk.dash i{flex:1;height:3px;border-radius:2px;background:#6a756f}
.mk.wave i{flex:1;min-width:2px;border-radius:2px;background:var(--good)}
.t-good .st{color:var(--ink)}
.ft{display:flex;align-items:center;gap:9px;margin:16px 0 0;font-size:17px;font-weight:700}
.ft i{flex:none;width:11px;height:11px;border-radius:50%;background:var(--good)}
.k-state_key .ft{font-weight:500;color:var(--mute);font-size:16px}
.k-state_key .ft i{display:none}
.rg{padding:14px 16px 12px}
.plot{position:relative;margin:0 14px}
.rw{position:relative;margin:0 0 38px}
.rh{position:relative;z-index:1;display:flex;justify-content:space-between;align-items:baseline;margin:0 0 8px;font-size:19px;font-weight:700;color:var(--ink)}
.rh{position:relative;z-index:1;margin:0;padding:0 0 8px;font-size:19px;font-weight:700;color:var(--ink);background:#fff}
.cs{padding:14px 16px}
.cr{margin:0 0 16px}
.cr:last-child{margin:0}
.cr p{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin:0 0 7px}
.cr span{font-size:17px;font-weight:700;color:var(--ink)}
.cr strong{font-family:${MONO};font-size:16px;font-weight:700;color:var(--blueMute);white-space:nowrap}
.cr.t-good strong{color:var(--blue)}
.qs{display:grid;height:30px}
.qs i{width:1px;background:var(--blueMute);justify-self:start}
.qs i:only-child{width:8px;border-radius:2px}
.cr.t-good .qs i{background:var(--blue)}
.rt{position:relative;height:22px}
.rt u{position:absolute;left:0;right:0;top:50%;height:4px;margin-top:-2px;border-radius:2px;background:#dfe6f3}
.pt{position:absolute;top:50%;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:var(--blueMute)}
.rb{position:absolute;top:50%;height:12px;margin-top:-6px;border-radius:3px;background:var(--blue);min-width:8px}
.rb:before,.rb:after{content:"";position:absolute;top:-5px;width:3px;height:22px;background:var(--blue);border-radius:1px}
.rb:before{left:0}.rb:after{right:0}
.gl{position:absolute;top:0;bottom:0;width:1px;background:#d5dcec}
.axis{position:relative;height:28px;margin:0 14px;border-top:1.5px solid var(--mute)}
.axis span{position:absolute;top:6px;transform:translateX(-50%);font-size:15px;font-weight:600;color:var(--mute);white-space:nowrap}
.au{margin:2px 14px 0;text-align:right;font-size:14px;font-weight:600;color:var(--mute)}
.axis span:first-child{transform:translateX(-35%)}
.axis span:last-child{transform:translateX(-72%)}
.arch{padding:14px 10px 14px;text-align:center;background:#fff}
.ly{margin:0;padding:2px 6px}
.ly.core{margin:2px 0;padding:14px 10px 14px;border:1.5px solid #8ea3c4;border-radius:14px;background:#f1f5fc}
.ln{display:flex;align-items:center;justify-content:center;gap:9px;margin:0;font-size:20px;line-height:1.15;font-weight:800;letter-spacing:-.01em}
.ln .ic{color:#2c5fae;flex:none}
.nx{text-wrap:balance;margin:5px 0 0;font-size:15.5px;line-height:1.3;color:var(--mute)}
.ni{display:grid;gap:8px;margin-top:14px}
.ni.n1{grid-template-columns:1fr}.ni.n2{grid-template-columns:repeat(2,1fr)}.ni.n3{grid-template-columns:repeat(3,1fr)}.ni.n4{grid-template-columns:repeat(2,1fr)}
.nd{display:flex;flex-direction:column;align-items:center;gap:3px;min-width:0}
.nd .ic{color:#2c5fae;margin-bottom:3px}
.nn{margin:0;font-size:18px;font-weight:800;line-height:1.15;overflow-wrap:anywhere}
.nd .nx{margin:0;font-size:13.5px}
.ar{display:flex;align-items:center;justify-content:center;gap:9px;margin:6px 0;color:#2c5fae;font-size:15.5px;font-weight:600}
.ar span{color:var(--mute)}
.log{background:var(--card);border:1.5px solid var(--line);border-radius:18px;padding:10px;margin:0 0 12px}
.lg{display:flex;flex-direction:column;gap:5px;padding:12px 14px 13px;border-radius:12px}
.lg+.lg{margin-top:8px}
.lg.t-bad{background:var(--badbg);color:var(--bad)}
.lg.t-good{background:var(--goodbg);color:var(--good)}
.lt{font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
.lt em{font-style:normal;opacity:.8}
.lg code{font-family:${MONO};font-size:24px;line-height:1.2;font-weight:700;white-space:pre;overflow-wrap:normal}
.df{border-radius:4px;padding:0 2px;margin:0 -2px;color:inherit}
.t-bad .df{background:#ffc7b5}.t-good .df{background:#a9dfbf}
.gp{display:inline-block;visibility:hidden}
.cc{margin:0 0 8px;padding:1px 0 1px 10px;border-left:4px solid var(--line)}
.cc.t-bad{border-left-color:var(--bad)}.cc.t-good{border-left-color:var(--good)}
.slots{display:block}
.sl{background:var(--card);border:1.5px solid var(--line);border-radius:18px;padding:12px 14px 14px;margin:0}
.bar{display:flex;align-items:center;gap:12px;height:66px;padding:0 14px;border-radius:14px;background:#eef1ee;color:#5f6b65}
.t-good .bar{color:var(--good)}
.pl{flex:none}
.trk2{flex:1;height:42px;min-width:0}
.trk2 .mk{height:100%;margin:0;padding:0;background:none}
.sl .st{margin:11px 0 0;font-size:22px}
.sw{display:flex;justify-content:center;color:var(--mute);margin:7px 0}
.pbar{height:46px}
.pbar u{height:100%;top:0;margin-top:0;border-radius:12px;background:#e3e9f5}
.wt{position:absolute;left:0;top:0;bottom:0;overflow:hidden;display:flex;align-items:center}
.wt s{display:flex;gap:5px;padding:0 8px;text-decoration:none}
.wt i{flex:none;width:9px;height:3px;border-radius:2px;background:#6d7a92}
.pw{position:absolute;top:0;bottom:0;overflow:hidden}
.pw s{display:flex;align-items:center;justify-content:space-evenly;gap:2px;height:100%;padding:10px 5px;text-decoration:none}
.pw i{flex:none;width:3px;border-radius:2px;background:#0d8a5f}
.rb.open{border-radius:3px 0 0 3px;background:linear-gradient(90deg,var(--blue),rgba(27,79,159,.15))}
.rb.open:after{display:none}
.pbar .rb{top:0;height:100%;margin-top:0;border-radius:8px;background:rgba(27,79,159,.3);border:3px solid var(--blue);min-width:12px}
.pbar .rb:before,.pbar .rb:after{display:none}
.pbar .pt{top:50%;width:22px;height:22px;margin:-11px 0 0 -11px;border:3px solid #fff;box-shadow:0 0 0 1.5px var(--blueMute)}
.vl{position:absolute;top:100%;margin-top:6px;transform:translateX(-50%);font-size:18px;font-weight:800;color:var(--blue);white-space:nowrap;background:#fff;padding:0 4px;z-index:2}
.rw.t-neutral .vl{color:var(--blueMute)}
.rw.t-good .pt{background:var(--blue)}
.vl.flip{transform:translateX(-88%)}
.vl.lo{transform:translateX(-12%)}
@media(min-width:760px){.pg{max-width:620px;padding:44px 24px 48px}h1{font-size:42px}.sb{font-size:21px}}`;
