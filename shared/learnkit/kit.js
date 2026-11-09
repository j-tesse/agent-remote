/* learnkit v1 — behaviour for kit.css. Don't edit; extend via LK.onEnter / LK.onStep. */
(function () {
  "use strict";
  var root = document.documentElement;
  root.classList.add("lk-js");
  var reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var $$ = function (sel, el) {
    return Array.prototype.slice.call((el || document).querySelectorAll(sel));
  };

  var enterCbs = new Map();
  var stepCbs = new Map();
  // Last step fired per element, so a late LK.onStep still sees the current state.
  var lastStep = new Map();
  function fireStep(el, id, detail) {
    lastStep.set(el, [id, detail]);
    (stepCbs.get(el) || []).forEach(function (fn) {
      fn(id, detail);
    });
  }

  function enter(el) {
    if (el.classList.contains("lk-in")) return;
    el.classList.add("lk-in");
    (enterCbs.get(el) || []).forEach(function (fn) {
      fn(el);
    });
    if (el.hasAttribute("data-lk-count")) count(el);
  }

  // One observer for everything that animates on first sight.
  var io =
    "IntersectionObserver" in window
      ? new IntersectionObserver(
          function (entries) {
            entries.forEach(function (e) {
              if (e.isIntersecting) {
                enter(e.target);
                io.unobserve(e.target);
              }
            });
          },
          { rootMargin: "0px 0px -12% 0px", threshold: 0.15 },
        )
      : null;
  function watch(el) {
    if (io && !reduced) io.observe(el);
    else enter(el);
  }

  // Stagger: children of [data-lk-stagger] reveal one after another.
  $$("[data-lk-stagger]").forEach(function (parent) {
    var step = parseInt(parent.getAttribute("data-lk-stagger"), 10) || 120;
    Array.prototype.forEach.call(parent.children, function (child, i) {
      if (!child.hasAttribute("data-lk-reveal")) child.setAttribute("data-lk-reveal", "up");
      child.style.setProperty("--lk-delay", i * step + "ms");
    });
  });

  // SVG draw-on: measure each stroke so dasharray matches its length.
  $$("[data-lk-draw]").forEach(function (el) {
    var shapes = el.matches("path,line,polyline") ? [el] : $$("path,line,polyline,circle,rect", el);
    shapes.forEach(function (s, i) {
      try {
        var len = Math.ceil(s.getTotalLength()) + 1;
        s.style.setProperty("--lk-len", len);
        if (el.hasAttribute("data-lk-stagger-draw"))
          s.style.setProperty("--lk-delay", i * (parseInt(el.getAttribute("data-lk-stagger-draw"), 10) || 250) + "ms");
      } catch (e) {}
    });
  });

  $$("[data-lk-reveal],[data-lk-draw],[data-lk-count],[data-lk-enter]").forEach(watch);

  // Counter: <span data-lk-count="1500" data-lk-decimals="0" data-lk-suffix="%">0</span>
  function count(el) {
    var to = parseFloat(el.getAttribute("data-lk-count")) || 0;
    var from = parseFloat(el.getAttribute("data-lk-from")) || 0;
    var dec = parseInt(el.getAttribute("data-lk-decimals"), 10) || 0;
    var pre = el.getAttribute("data-lk-prefix") || "";
    var suf = el.getAttribute("data-lk-suffix") || "";
    var dur = parseInt(el.getAttribute("data-lk-duration"), 10) || 1200;
    var fmt = function (v) {
      return pre + v.toLocaleString(undefined, { minimumFractionDigits: dec, maximumFractionDigits: dec }) + suf;
    };
    if (reduced) return (el.textContent = fmt(to));
    var t0 = performance.now();
    (function tick(now) {
      var t = Math.min(1, (now - t0) / dur);
      var k = 1 - Math.pow(1 - t, 3);
      el.textContent = fmt(from + (to - from) * k);
      if (t < 1) requestAnimationFrame(tick);
    })(t0);
  }

  // Progress bar: add <div class="lk-progress"></div> anywhere (auto-added if missing).
  var bar = document.querySelector(".lk-progress");
  if (!bar && !document.body.hasAttribute("data-lk-no-progress")) {
    bar = document.createElement("div");
    bar.className = "lk-progress";
    document.body.appendChild(bar);
  }
  function progress() {
    if (!bar) return;
    var max = root.scrollHeight - root.clientHeight;
    bar.style.setProperty("--lk-progress", max > 0 ? Math.min(1, root.scrollTop / max) : 0);
  }
  window.addEventListener("scroll", progress, { passive: true });
  window.addEventListener("resize", progress);
  progress();

  // Scrollytelling: the step nearest the viewport's middle third is active.
  $$("[data-lk-scrolly]").forEach(function (box) {
    var fig = box.querySelector(".lk-scrolly-figure");
    var steps = $$(".lk-scrolly-step", box);
    if (!steps.length) return;
    var current = null;
    function activate(step) {
      if (step === current) return;
      current = step;
      steps.forEach(function (s) {
        s.classList.toggle("lk-active", s === step);
      });
      var id = step.getAttribute("data-step") || String(steps.indexOf(step) + 1);
      box.setAttribute("data-active-step", id);
      if (fig) fig.setAttribute("data-active-step", id);
      var detail = { step: id, index: steps.indexOf(step), el: step };
      box.dispatchEvent(new CustomEvent("lk:step", { detail: detail }));
      fireStep(box, id, detail);
    }
    if ("IntersectionObserver" in window) {
      var sio = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (e) {
            if (e.isIntersecting) activate(e.target);
          });
        },
        { rootMargin: "-45% 0px -45% 0px" },
      );
      steps.forEach(function (s) {
        sio.observe(s);
      });
    }
    activate(steps[0]);
  });

  // Stepper: tap through panels in place.
  $$("[data-lk-stepper]").forEach(function (box) {
    var panels = $$(".lk-stepper-panel", box);
    if (!panels.length) return;
    var nav = box.querySelector(".lk-stepper-nav");
    if (!nav) {
      nav = document.createElement("div");
      nav.className = "lk-stepper-nav";
      nav.innerHTML =
        '<button class="lk-btn" data-lk-prev aria-label="Previous">←</button>' +
        '<span class="lk-stepper-count" aria-live="polite"></span>' +
        '<button class="lk-btn lk-btn--primary" data-lk-next aria-label="Next">→</button>';
      box.appendChild(nav);
    }
    var prev = nav.querySelector("[data-lk-prev]");
    var next = nav.querySelector("[data-lk-next]");
    var label = nav.querySelector(".lk-stepper-count");
    var i = 0;
    function show(n) {
      i = Math.max(0, Math.min(panels.length - 1, n));
      panels.forEach(function (p, k) {
        p.hidden = k !== i;
      });
      if (prev) prev.disabled = i === 0;
      if (next) next.disabled = i === panels.length - 1;
      if (label) label.textContent = i + 1 + " / " + panels.length;
      box.setAttribute("data-active-step", String(i + 1));
      var detail = { step: String(i + 1), index: i, el: panels[i] };
      box.dispatchEvent(new CustomEvent("lk:step", { detail: detail }));
      fireStep(box, detail.step, detail);
    }
    if (prev) prev.addEventListener("click", function () { show(i - 1); });
    if (next) next.addEventListener("click", function () { show(i + 1); });
    show(0);
  });

  // Slider: <div class="lk-slider" data-lk-slider data-lk-target="#fig"> + <input type=range>.
  // Sets --lk-v (raw) and --lk-t (0..1) on the target; fills [data-lk-out] with the value.
  $$("[data-lk-slider]").forEach(function (box) {
    var input = box.querySelector('input[type="range"]');
    if (!input) return;
    var sel = box.getAttribute("data-lk-target");
    var target = sel ? document.querySelector(sel) : box;
    function update() {
      var v = parseFloat(input.value);
      var min = parseFloat(input.min || "0");
      var max = parseFloat(input.max || "100");
      [box, target].forEach(function (t) {
        if (!t) return;
        t.style.setProperty("--lk-v", v);
        t.style.setProperty("--lk-t", max > min ? (v - min) / (max - min) : 0);
      });
      $$("[data-lk-out]").forEach(function (o) {
        if (box.contains(o) || (input.id && o.getAttribute("data-lk-out") === input.id)) o.textContent = input.value;
      });
      box.dispatchEvent(new CustomEvent("lk:input", { detail: { value: v } }));
      fireStep(box, v, { value: v, el: input });
    }
    input.addEventListener("input", update);
    update();
  });

  // Quiz: buttons inside [data-lk-quiz]; the right one has data-correct, optional data-why.
  $$("[data-lk-quiz]").forEach(function (box) {
    var fb = box.querySelector(".lk-feedback");
    if (!fb) {
      fb = document.createElement("p");
      fb.className = "lk-feedback";
      fb.setAttribute("aria-live", "polite");
      box.appendChild(fb);
    }
    var done = false;
    $$("button", box).forEach(function (b) {
      b.addEventListener("click", function () {
        if (done) return;
        var right = b.hasAttribute("data-correct");
        b.classList.add(right ? "lk-correct" : "lk-wrong");
        fb.setAttribute("data-state", right ? "right" : "wrong");
        fb.textContent = b.getAttribute("data-why") || (right ? "Correct!" : "Not quite — try again.");
        if (right) {
          done = true;
          box.classList.add("lk-solved");
          box.dispatchEvent(new CustomEvent("lk:solved"));
        }
      });
    });
  });

  // Tap to reveal: <button data-lk-toggle="#id"> shows/hides #id (class lk-toggle-body, hidden).
  $$("[data-lk-toggle]").forEach(function (b) {
    var t = document.querySelector(b.getAttribute("data-lk-toggle"));
    if (!t) return;
    b.setAttribute("aria-expanded", String(!t.hidden));
    b.addEventListener("click", function () {
      t.hidden = !t.hidden;
      b.setAttribute("aria-expanded", String(!t.hidden));
    });
  });
  $$(".lk-flip").forEach(function (card) {
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    var flip = function () {
      card.classList.toggle("lk-flipped");
    };
    card.addEventListener("click", flip);
    card.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        flip();
      }
    });
  });

  function add(map, el, fn) {
    if (typeof el === "string") el = document.querySelector(el);
    if (!el) return;
    map.set(el, (map.get(el) || []).concat(fn));
  }
  window.LK = {
    reduced: reduced,
    /** Run fn(el) the first time el scrolls into view (el needs data-lk-enter, or any lk reveal attr). */
    onEnter: function (el, fn) {
      if (typeof el === "string") el = document.querySelector(el);
      if (!el) return;
      add(enterCbs, el, fn);
      if (el.classList.contains("lk-in")) fn(el);
      else if (!el.matches("[data-lk-reveal],[data-lk-draw],[data-lk-count],[data-lk-enter]")) watch(el);
    },
    /** fn(stepId, detail) when a scrolly/stepper changes step, or a slider moves (fn(value)). */
    onStep: function (el, fn) {
      if (typeof el === "string") el = document.querySelector(el);
      if (!el) return;
      add(stepCbs, el, fn);
      var last = lastStep.get(el);
      if (last) fn(last[0], last[1]);
    },
  };
})();
