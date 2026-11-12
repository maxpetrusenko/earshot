/**
 * Styles for the explain page. Light only. Orca theme tokens are read with fallbacks and never redefined.
 * Fonts are local faces with fallbacks: the Orca frame has no network access, so nothing is fetched.
 */
const SANS = `"Avenir Next","Gill Sans","Source Sans 3","Segoe UI","Trebuchet MS",sans-serif`;
const SERIF = `"Iowan Old Style","Source Serif 4","Palatino Linotype",Georgia,serif`;
const MONO = `"SF Mono",Menlo,"Cascadia Mono",Consolas,monospace`;

const FG = "var(--foreground,#1b1b18)";
const MUTED = "var(--muted-foreground,#5b5a52)";
const ACC = "var(--primary,#1f6f5c)";
const BAD = "var(--destructive,#b42318)";
const LINE = "var(--border,#d6cfbf)";
const CARD = "var(--card,#ffffff)";
const SOFT = "var(--secondary,#f1ebdd)";
const HL = "#b45309";

export const EXPLAIN_CSS = `*{box-sizing:border-box}
html{background:radial-gradient(760px 340px at 100% 0,rgba(31,111,92,.10),transparent 65%),radial-gradient(520px 260px at 0 100%,rgba(180,83,9,.07),transparent 70%),linear-gradient(180deg,var(--background,#fbf8f3),#f4efe4);min-height:100%}
body{margin:0;font-family:${SANS};font-size:16px;line-height:1.35;color:${FG}}
.ex{max-width:1200px;margin:0 auto;padding:14px 12px 16px}
h1{font-family:${SERIF};font-size:26px;line-height:1.12;margin:0 0 4px;font-weight:700;letter-spacing:-.01em}
.tk{margin:0 0 12px;font-size:17px;color:${MUTED}}
.ps{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}
.pn{display:flex;flex-direction:column;background:${CARD};border:1px solid ${LINE};border-top:5px solid ${MUTED};border-radius:12px;padding:12px 12px 14px;box-shadow:0 8px 20px -12px rgba(27,27,24,.35)}
.pn.a{border-top-color:${ACC}}
.pn h2{font-size:17px;margin:0 0 10px;font-weight:700}
.pn.a h2{color:${ACC}}
.fr{flex:1;border:1.5px solid ${FG};border-radius:10px;overflow:hidden;background:#fffdf8}
.fr.phone{max-width:300px;margin:0 auto;border-radius:26px;border-width:2px}
.tb{display:flex;align-items:center;gap:6px;padding:7px 10px;background:${SOFT};border-bottom:1.5px solid ${FG};font-size:13px;color:${MUTED}}
.tb i{width:10px;height:10px;border-radius:50%;background:#bdb5a3;display:block}
.tb span{margin-left:6px;font-weight:600}
.nt{width:84px;height:14px;margin:8px auto 0;border-radius:8px;background:${SOFT}}
.fb{padding:10px;display:flex;flex-direction:column;gap:8px}
.el{padding:9px 12px;border-radius:9px;border:1.5px solid ${LINE};background:#fff;font-size:16px;overflow-wrap:anywhere}
.el.s-bad{border-color:${BAD};background:#fdf1ef}
.el.s-good{border-color:${ACC};background:#eaf4f0}
.el.s-muted{color:${MUTED};background:${SOFT};border-style:dashed}
.ctl{display:flex;flex-wrap:wrap;gap:6px;padding:8px}
.ctl span{padding:6px 12px;border-radius:999px;border:1.5px solid ${ACC};color:${ACC};font-weight:700;font-size:15px}
.ctl.s-good span:first-child{background:${ACC};color:#fff}
.ctl.s-bad span{border-color:${BAD};color:${BAD}}
.btn{border-radius:999px;text-align:center;font-weight:700;border-color:${ACC};color:${ACC}}
.btn.s-good{background:${ACC};color:#fff}
.btn.s-bad{color:${BAD};border-color:${BAD}}
.lnk{border:0;background:none;padding:2px 4px;color:${ACC};text-decoration:underline;text-underline-offset:3px;font-weight:700}
.lnk.s-bad{color:${BAD};background:none}
.lnk.s-good,.lnk.s-muted{background:none}
.tx{border:0;background:none;padding:2px 4px}
.tx.s-bad,.tx.s-good,.tx.s-muted{background:none}
.bub{max-width:86%;border-radius:16px 16px 16px 4px;background:${SOFT};border-color:transparent}
.bub.r{align-self:flex-end;border-radius:16px 16px 4px 16px;background:${ACC};color:#fff}
.bar span{display:block;margin-bottom:7px;font-weight:600}
.trk{height:8px;border-radius:4px;background:#e4dccb;overflow:hidden}
.trk b{display:block;height:100%;background:${ACC};border-radius:4px}
.bar.s-bad .trk b{background:${BAD}}
.ew{display:flex;flex-direction:column;gap:3px}
.ew.hl>.el{outline:3px solid ${HL};outline-offset:3px}
.an{display:flex;align-items:flex-start;gap:6px;color:${HL};font-weight:700;font-size:14px;line-height:1.25;padding:2px 0 0 10px}
.an svg{flex:none}
.wv{display:flex;align-items:center;gap:10px;padding:8px 12px}
.wb{display:flex;align-items:center;gap:2px;height:34px;flex:1}
.wb i{display:block;flex:1;min-width:2px;background:#cfc6b2;border-radius:2px}
.wb i.on{background:${ACC}}
.wv span{font-size:14px;font-weight:700;color:${MUTED};white-space:nowrap}
.jy{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.st{display:flex;flex-direction:column;gap:5px;position:relative;padding:8px 10px 10px 42px;border:1.5px solid ${LINE};border-radius:10px;background:#fffdf8}
.st.op{border-style:dashed;border-color:${HL}}
.st.s-good{border-color:${ACC}}
.st small{font-size:13px;font-weight:700;color:${MUTED}}
.sn{position:absolute;left:10px;top:9px;width:24px;height:24px;border-radius:50%;background:${FG};color:#fff;display:flex;align-items:center;justify-content:center;font-size:14px}
.sa{display:none}
.cp{margin:12px 0 0;padding-top:10px;border-top:1px solid ${LINE};font-size:16px;font-weight:600;color:${FG}}
.row{border-radius:6px}
.dg{display:block;width:100%;height:auto}
.dg .lb{fill:${FG};font-family:${SANS}}
.dg .mt{stroke:#fff;stroke-width:4px;paint-order:stroke}
.dg .lm{fill:${MUTED};font-family:${SANS}}
.dg .tr{fill:#eee7d6}
.dg .sg{fill:${ACC}}
.dg .sg.s-bad{fill:${BAD}}
.dg .sg.s-muted{fill:#bdb5a3}
.dg .sl{fill:#fff;font-family:${SANS}}
.dg .sl.s-muted{fill:${FG}}
.dg .mk{stroke:${HL};stroke-width:3}
.dg .mkh{fill:${HL}}
.dg .ax{stroke:${MUTED};stroke-width:1.5}
.dg .nd{fill:#fff;stroke:${FG};stroke-width:1.5}
.dg .nd.s-good{fill:#eaf4f0;stroke:${ACC};stroke-width:2.5}
.dg .nd.s-bad{fill:#fdf1ef;stroke:${BAD};stroke-width:2.5}
.dg .nd.s-muted{fill:${SOFT};stroke:#bdb5a3}
.dg .ll{stroke:#c9c0ac;stroke-width:1.5;stroke-dasharray:4 4}
.dg .ln{stroke:${FG};stroke-width:2;fill:none}
.dg .ln.ds{stroke-dasharray:6 4}
.dg .ah{fill:${FG}}
.dg .lg{fill:#fffdf8;stroke:${LINE}}
.io{display:flex;flex-direction:column;gap:6px}
.io .bx{border:1.5px solid ${FG};border-radius:10px;padding:10px 12px;background:#fffdf8}
.io .bx.o{border-color:${ACC};background:#eaf4f0}
.io .bx small{display:block;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${MUTED};margin-bottom:4px}
.io .bx code{font-family:${MONO};font-size:15px;overflow-wrap:anywhere;white-space:pre-wrap}
.io .tf{display:flex;align-items:center;gap:10px;padding:2px 8px;color:${ACC};font-weight:700}
.io .tf svg{flex:none}
.mx{list-style:none;margin:12px 0 0;padding:0;display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
.mx li{background:${CARD};border:1px solid ${LINE};border-radius:10px;padding:10px 12px}
.ml{display:block;font-size:14px;color:${MUTED};margin-bottom:2px}
.mv{font-family:${SERIF};font-size:26px;font-weight:700;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.mv s{font-size:20px;color:${MUTED};font-weight:400;text-decoration-thickness:2px}
.mv b{color:${ACC}}
.tg{display:block;width:100%;font-family:${SANS};font-size:13px;font-weight:600;color:${MUTED}}
.tg.ms{color:${ACC}}
.co{list-style:none;margin:12px 0 0;padding:0;display:grid;gap:10px;counter-reset:c}
.co li{counter-increment:c;display:flex;gap:12px;align-items:baseline;font-size:17px;border-left:4px solid ${ACC};padding:2px 0 2px 12px}
.co li:before{content:counter(c);font-family:${SERIF};font-weight:700;font-size:22px;color:${ACC}}
@media(min-width:760px){.ps.two{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}h1{font-size:32px}.ex{padding:20px 22px 22px}.jy{flex-direction:row;align-items:stretch}.st{flex:1;padding:36px 10px 10px}.sn{top:8px}.sa{display:flex;align-items:center;color:${MUTED}}}`;
