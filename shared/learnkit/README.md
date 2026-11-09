# learnkit v1

Building blocks for a single-page, mobile-first, scroll-through lesson. Load the kit in `<head>` with `<link rel="stylesheet" href="learnkit/kit.css">` and put `<script src="learnkit/kit.js"></script>` at the **end of `<body>`**. Your own `<script>` goes after it. **Don't edit these files.** Override `--lk-*` variables or add styles in the page itself.

Everything is declarative (`class` / `data-lk-*`), works with no JS (it degrades to its end state), and respects `prefers-reduced-motion`.

## Page skeleton
```html
<main class="lk">
  <header class="lk-hero">
    <p class="lk-kicker">Topic</p>
    <h1>A question worth scrolling for?</h1>
    <p class="lk-lede">One sentence of promise.</p>
    <p class="lk-scroll-hint">Scroll ↓</p>
  </header>
  <section class="lk-screen"> … one idea … </section>
  <section class="lk-screen lk-screen--full"> … a screen that fills the viewport … </section>
</main>
```
A progress bar is added automatically; `<body data-lk-no-progress>` turns it off.

## Theme
Set these on `:root` in the page: `--lk-accent`, `--lk-bg`, `--lk-surface`, `--lk-raised`, `--lk-text`, `--lk-muted`, `--lk-good`, `--lk-bad`, `--lk-warn`, `--lk-radius`, `--lk-max` (column width, 640px). Dark mode is built in.

## Text blocks
```html
<p class="lk-kicker">Step 2</p>                      <!-- small accent label -->
<span class="lk-term">entropy</span>                  <!-- highlighted key term -->
<div class="lk-big">42%</div>                         <!-- big stat -->
<div class="lk-callout"><strong>Note</strong>…</div>  <!-- also lk-callout--tip / --warn -->
<div class="lk-card">…</div>
<ol class="lk-steps"><li>…</li><li>…</li></ol>        <!-- numbered steps -->
<div class="lk-compare"><div>Before…</div><div>After…</div></div>
<figure class="lk-figure"><svg viewBox="0 0 360 240">…</svg><figcaption>…</figcaption></figure>
<div class="lk-recap"><h3>Recap</h3><ul><li>…</li></ul></div>
<button class="lk-btn">…</button> <button class="lk-btn lk-btn--primary">…</button>
```
SVG `text` inherits `currentColor`. Use `viewBox` with no width/height so it scales, aim for a ~360px-wide design, and keep labels ≥14px at that size.

## Reveal on scroll
```html
<p data-lk-reveal>fades up</p>       <!-- values: up (default) | left | right | scale -->
<ul data-lk-stagger="150">           <!-- children reveal one by one, 150ms apart -->
  <li>…</li><li>…</li>
</ul>
```
Each element that enters the viewport gets the class `lk-in` (once), and you can key your own CSS off `.lk-in`.

## Scrollytelling (sticky figure + steps)
The figure sticks while steps scroll over it. The active step's `data-step` is mirrored onto the figure as `data-active-step`, so the figure is driven by CSS:
```html
<section class="lk-scrolly" data-lk-scrolly>
  <div class="lk-scrolly-figure">
    <svg viewBox="0 0 360 240"><circle class="dot" cx="60" cy="120" r="20"/></svg>
  </div>
  <div class="lk-scrolly-steps">
    <div class="lk-scrolly-step" data-step="start">A dot sits still.</div>
    <div class="lk-scrolly-step" data-step="move">Now it moves.</div>
  </div>
</section>
<style>
  .dot { fill: var(--lk-accent); }
  [data-active-step="move"] .dot { transform: translateX(200px); }
</style>
```
Everything inside `.lk-scrolly-figure` transitions opacity/transform/fill/stroke automatically. For JS: `LK.onStep(sectionEl, (step, d) => …)`, or listen for the `lk:step` event.

## SVG line drawing
```html
<svg viewBox="0 0 360 120" data-lk-draw data-lk-stagger-draw="300">
  <path d="M10 100 C 120 0, 240 200, 350 20" fill="none" stroke="currentColor" stroke-width="3"/>
</svg>
```
Strokes draw in when scrolled into view (on a `path`, `line` or `polyline` itself, or on every shape inside the marked element).

## Counter
```html
<span class="lk-big" data-lk-count="1500" data-lk-suffix=" km" data-lk-decimals="0">0</span>
```
Optional: `data-lk-from`, `data-lk-prefix`, `data-lk-duration` (ms).

## Stepper (tap through in place)
```html
<div class="lk-stepper" data-lk-stepper>
  <div class="lk-stepper-panel">Step one…</div>
  <div class="lk-stepper-panel">Step two…</div>
</div>
```
Prev/next buttons and an `n / N` count are added automatically. The box gets `data-active-step="1"`, `"2"`, … for CSS, and `LK.onStep(box, fn)` works the same as for scrolly. Good for a diagram that changes per tap.

## Slider (explorable)
```html
<div class="lk-slider" data-lk-slider data-lk-target="#wave">
  <label>Frequency <span data-lk-out></span></label>
  <input type="range" min="1" max="10" value="3">
</div>
<svg id="wave" viewBox="0 0 360 120">…</svg>
<style> #wave path { transform: scaleX(calc(1 / var(--lk-v))); } </style>
```
The target (and the box) get `--lk-v` (the value) and `--lk-t` (0..1). `[data-lk-out]` inside the box shows the value. For anything CSS can't express, use `LK.onStep(boxEl, v => …)`.

## Quiz
```html
<div class="lk-quiz" data-lk-quiz>
  <p class="lk-quiz-q">Which is bigger?</p>
  <button data-why="Nope — that's the smaller one.">A</button>
  <button data-correct data-why="Yes! Because …">B</button>
</div>
```
Wrong answers shake and can be retried, and the first right answer locks the quiz (event `lk:solved`). Explain *why* in `data-why`.

## Tap to reveal
```html
<button class="lk-btn" data-lk-toggle="#ans">Show answer</button>
<div id="ans" class="lk-toggle-body" hidden>…</div>

<div class="lk-flip">
  <div class="lk-flip-inner">
    <div class="lk-flip-front">Term</div>
    <div class="lk-flip-back">Definition</div>
  </div>
</div>
```

## JS hooks
- `LK.onEnter(el | selector, el => …)`: runs once, when the element first scrolls into view.
- `LK.onStep(el | selector, (step, detail) => …)`: fires for scrolly/stepper step changes and slider input, and immediately with the current state.
- `LK.reduced`: `true` when the user prefers reduced motion; skip your own animations then.
