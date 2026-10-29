// Page motion after the Ascend template: Lenis smooth scroll, staggered
// fade-up reveals, smooth in-page anchors. Progressive: without JS, without
// the Lenis CDN or with reduced motion, everything is visible and the anchors
// still work.

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const year = document.getElementById("year");
if (year) year.textContent = String(new Date().getFullYear());

// ---------------------------------------------------------------- reveals
const revealEls = [...document.querySelectorAll("[data-reveal]")];
const showAll = () => revealEls.forEach((el) => el.classList.add("in"));
if (reduceMotion || !("IntersectionObserver" in window)) {
  showAll();
} else {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add("in");
        io.unobserve(e.target);
      }
    },
    { threshold: 0.18, rootMargin: "0px 0px -8% 0px" },
  );
  revealEls.forEach((el) => io.observe(el));
  // Tall blocks (the console) can never reach 18% visibility on a short
  // screen; reveal anything that has entered the viewport at all.
  const tall = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting && e.boundingClientRect.height > window.innerHeight * 0.9) {
          e.target.classList.add("in");
          tall.unobserve(e.target);
        }
      }
    },
    { threshold: 0 },
  );
  revealEls.forEach((el) => tall.observe(el));
}

// ---------------------------------------------------------------- smooth scroll
let lenis = null;
if (!reduceMotion) {
  const url = "https://unpkg.com/lenis@1.3.23/dist/lenis.mjs";
  import(url)
    .then(({ default: Lenis }) => {
      lenis = new Lenis({ duration: 1.15, smoothWheel: true, touchMultiplier: 1.5 });
      const raf = (t) => {
        lenis.raf(t);
        requestAnimationFrame(raf);
      };
      requestAnimationFrame(raf);
    })
    .catch(() => {
      /* CDN unreachable: native scrolling is fine */
    });
}

document.addEventListener("click", (e) => {
  const a = e.target.closest('a[href^="#"]');
  if (!a) return;
  const id = a.getAttribute("href").slice(1);
  const el = id ? document.getElementById(id) : null;
  if (!el) return;
  e.preventDefault();
  if (lenis) lenis.scrollTo(id === "top" ? 0 : el, { offset: id === "top" ? 0 : -12 });
  else if (id === "top") window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  else el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
});
