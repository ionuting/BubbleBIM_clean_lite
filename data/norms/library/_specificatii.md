---
titlu: Specificații
---

# Specificații: ce se poate roti fără să schimbi modelul

Sistemul structural spune CUM se construiește peretele. Specificațiile spun din
CE: ce cărămidă, ce tencuială, ce termoizolație, ce pardoseală. Sunt ortogonale
— o casă din zidărie confinată poate avea BCA sau Porotherm, vată sau
polistiren, în orice combinație — și tocmai de asta sunt deciziile pe care un
simulator de cost trebuie să le poată compara.

**Un grup = o decizie.** Are o opțiune implicită, o listă de tipuri de nod pe
care se poate suprascrie punctual (`spec_<grup>` în proprietăți) și, dacă
implicitul e o mapare care exista deja fără specificație, lista articolelor
acelei mapări. Când alegi altceva decât implicitul, acele articole ies din deviz
și intră mapările opțiunii alese.

**Cum adaugi o opțiune nouă**, fără să atingi nimic existent:

1. scrii articolele ei în fișierul categoriei (`tencuiala.md`, `zidarie.md`, …);
2. scrii aici un rând în `## Opțiuni`;
3. scrii în același fișier de categorie rândurile de mapare cu
   `spec = grup:opțiune`;
4. recompilezi. Opțiunea apare singură în bara de scenarii și în optimizator —
   pârghiile sunt derivate din acest fișier, nu scrise în cod.

Coloana `articole implicite` e goală pentru grupurile complet noi (pardoseală,
faianță, șapă, rigips): acolo chiar și opțiunea implicită își poartă propriile
mapări, deci o opțiune „fără" funcționează prin simpla dezactivare a lor.

**Pe verticală.** O alegere nu e obligatoriu aceeași pe toată înălțimea unui
element. O bandă (`covering_layers` la cameră, `wall_layers` la perete,
`shell_zones` la anvelopă — vezi `lib/zones/heightZones.ts`) își poartă propriile
alegeri în câmpul `spec`, scrise ca `grup:opțiune` separate prin virgulă. Așa se
scrie „faianță pe primii 1.5 m, tencuială în rest" sau „soclu din BCA pe primii
30 cm": aceleași grupuri, aplicate pe o felie de înălțime.

## Grupuri
| grup | etichetă | aplicabil | implicit | articole implicite | descriere |
|---|---|---|---|---|---|
| zidarie | Zidărie | wall | porotherm38 | 0001_00201A01_02 | Blocul din care se ridică pereții portanți de zidărie |
| beton | Clasa betonului | column, ax, beam | c20_santier | 0002_CA01D_02, 0003_CA01D_02 | Clasa și modul de punere în operă pentru sâmburi și centuri |
| lemn | Lemn de structură | wall | c24 | 0019_LF01_TF | Esența și clasa montanților și tălpilor din pereții de lemn |
| tencuiala_int | Tencuială interioară | room | ipsos | 0011_CF24A_02 | Tencuiala pereților la interior |
| tencuiala_ext | Tencuială exterioară | shell | driscuita | 0011_CF06B1_82 | Stratul de finisaj al fațadei, peste termoizolație |
| termoizolatie | Termoizolație fațadă | shell | eps10 | 0012_00107A011_02 | Materialul și grosimea izolației de fațadă |
| vopsitorie | Vopsitorie | room, shell | lavabila | 0013_CN05A_02, 0013_CN11A_02 | Vopseaua de interior și de exterior |
| invelitoare | Învelitoare | roof | tabla | 0006_CE07A_02 | Materialul de acoperire al șarpantei |
| sapa | Șapă | room | cimentata |  | Stratul suport al pardoselii |
| pardoseala | Pardoseală | room | parchet_laminat |  | Finisajul de călcare din camere |
| faianta | Faianță pereți | room | fara |  | Placarea ceramică a pereților, în camerele umede |
| rigips | Pereți gips-carton | wall | standard |  | Placarea compartimentărilor ușoare W10 și W12 |

## Opțiuni
| grup | opțiune | etichetă | material | lambda | grosime | descriere |
|---|---|---|---|---|---|---|
| zidarie | porotherm38 | Porotherm 38 (implicit) | brick | 0.14 | 380 | Blocuri ceramice cu locaș de mortar |
| zidarie | bca25 | BCA 25 cm | aac_block | 0.11 | 250 | Beton celular autoclavizat, mai ieftin și mai ușor |
| zidarie | caramida_plina | Cărămidă plină presată | brick | 0.80 | 250 | Grea, scumpă, folosită la reabilitări și la soclu |
| beton | c20_santier | C20/25 preparat pe șantier (implicit) |  |  |  | Betonieră la fața locului |
| beton | c25_pompat | C25/30 gata preparat, pompat |  |  |  | Autobetonieră + pompă |
| beton | c30_pompat | C30/37 gata preparat, pompat |  |  |  | Clasă superioară, expunere severă |
| lemn | c24 | Rășinoase C24 (implicit) | wood |  |  | Lemn ecarisat uscat, clasa de rezistență uzuală |
| lemn | lamelar | Lemn lamelar încleiat GL24h | wood |  |  | Stabil dimensional, secțiuni mari |
| lemn | lvl | LVL furnir laminat | wood |  |  | Rezistență mare, deschideri mari |
| tencuiala_int | ipsos | Ipsos 1 cm, manual (implicit) | plaster | 0.35 | 10 | Aplicare manuală |
| tencuiala_int | ipsos_mecanizat | Ipsos mecanizat | plaster | 0.35 | 10 | Pompă de tencuit, manoperă mai mică |
| tencuiala_int | var_ciment | Mortar var-ciment | plaster | 0.87 | 20 | Mai dur, suport pentru placări |
| tencuiala_int | fara | Fără tencuială |  |  |  | Pe banda placată cu faianță: șapa de sub placaj intră în articolul de placare |
| tencuiala_ext | driscuita | Driscuită 2.5 cm (implicit) | plaster | 0.87 | 25 | Tencuială obișnuită pe zidărie |
| tencuiala_ext | decorativa | Decorativă siliconică | plaster | 0.70 | 3 | Pe termosistem, structurată |
| tencuiala_ext | fara | Fără tencuială exterioară |  |  |  | Fațadă ventilată sau placare, tratate separat |
| termoizolatie | eps10 | Polistiren expandat 10 cm (implicit) | insulation | 0.038 | 100 | Termosistem clasic |
| termoizolatie | eps15 | Polistiren expandat 15 cm | insulation | 0.038 | 150 | Grosime sporită |
| termoizolatie | eps_grafitat10 | Polistiren grafitat 10 cm | insulation | 0.031 | 100 | Conductivitate mai bună la aceeași grosime |
| termoizolatie | vata15 | Vată bazaltică 15 cm | insulation | 0.035 | 150 | Ignifugă și permeabilă la vapori |
| termoizolatie | fibra_lemn16 | Fibră lemnoasă 16 cm | insulation | 0.040 | 160 | Biogenă, potrivită pe structuri de lemn |
| vopsitorie | lavabila | Lavabilă acrilică (implicit) |  |  |  | Interior și exterior |
| vopsitorie | premium | Lavabilă premium lavabilă |  |  |  | Rezistentă la spălare |
| vopsitorie | silicatica | Silicatică la exterior |  |  |  | Permeabilă la vapori, durabilă |
| vopsitorie | fara | Fără vopsitorie |  |  |  | Pe banda placată cu faianță nu se vopsește |
| invelitoare | tabla | Tablă faltuită (implicit) |  |  |  | Falț dublu pe astereală |
| invelitoare | tigla_ceramica | Țiglă ceramică |  |  |  | Grea, durabilă |
| invelitoare | tigla_metalica | Țiglă metalică |  |  |  | Ușoară, montaj rapid |
| sapa | cimentata | Șapă cimentată 5 cm (implicit) |  |  |  | Clasică, armată cu fibre |
| sapa | autonivelanta | Șapă autonivelantă |  |  |  | Plană, potrivită sub covor sau LVT |
| sapa | uscata | Șapă uscată din plăci |  |  |  | Fără uscare, potrivită la reabilitări |
| sapa | fara | Fără șapă |  |  |  | Placa se finisează direct |
| pardoseala | parchet_laminat | Parchet laminat (implicit) |  |  |  | Clasa 32, cu folie și izofon |
| pardoseala | parchet_stratificat | Parchet stratificat lemn |  |  |  | Strat de uzură din lemn masiv |
| pardoseala | gresie | Gresie porțelanată |  |  |  | Rezistentă, potrivită peste încălzire în pardoseală |
| pardoseala | lvt | Vinil LVT |  |  |  | Cald la atingere, montaj lipit sau click |
| pardoseala | fara | Fără pardoseală |  |  |  | Se decontează separat |
| faianta | fara | Fără faianță (implicit) |  |  |  | Se pune doar în camerele umede |
| faianta | standard | Faianță ceramică | ceramic_tile | 1.30 | 8 | Format uzual; înălțimea de placare vine din banda camerei |
| faianta | portelanata | Gresie porțelanată pe pereți | ceramic_tile | 1.30 | 9 | Format mare, rosturi fine |
| faianta | mare_format | Placă mare format | ceramic_tile | 1.30 | 10 | 120×60 și peste, manoperă în doi |
| rigips | standard | Gips-carton standard (implicit) |  |  |  | Placare simplă pe schelet metalic |
| rigips | ru | Gips-carton rezistent la umezeală |  |  |  | Camere umede |
| rigips | rf | Gips-carton rezistent la foc |  |  |  | Compartimentări cu cerință de rezistență la foc |
| rigips | dubla | Dublă placare pe fiecare față |  |  |  | Rigiditate și izolare fonică sporite |
