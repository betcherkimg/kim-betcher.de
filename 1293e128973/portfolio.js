"use strict";

document.documentElement.classList.add("js");

const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector(".site-nav");

function closeMenu({ returnFocus = false } = {}) {
  menuButton?.setAttribute("aria-expanded", "false");
  navigation?.classList.remove("is-open");
  if (returnFocus) menuButton?.focus();
}

menuButton?.addEventListener("click", () => {
  const expanded = menuButton.getAttribute("aria-expanded") !== "true";
  menuButton.setAttribute("aria-expanded", String(expanded));
  navigation?.classList.toggle("is-open", expanded);
});

navigation?.addEventListener("click", (event) => {
  if (event.target.closest("a")) closeMenu();
});

document.addEventListener("click", (event) => {
  if (!event.target.closest(".site-header")) closeMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && menuButton?.getAttribute("aria-expanded") === "true") {
    closeMenu({ returnFocus: true });
  }
});

window.matchMedia("(min-width: 761px)").addEventListener("change", () => closeMenu());

const preview = document.querySelector(".project-dialog");
if (preview && typeof preview.showModal === "function") {
  const previewImage = preview.querySelector("#preview-image");
  const previewTitle = preview.querySelector("#preview-title");
  const previewNote = preview.querySelector("#preview-note");
  const galleryNavigation = preview.querySelector(".preview-navigation");
  const counter = preview.querySelector(".preview-counter");
  const previewLinks = Array.from(document.querySelectorAll("a[data-preview]"));
  let gallery = [];
  let currentImage = 0;

  function renderPreview() {
    const link = gallery[currentImage];
    previewImage.src = link.href;
    previewImage.alt = link.querySelector("img")?.alt || `Bildschirmfoto: ${link.dataset.title}`;
    previewTitle.textContent = link.dataset.title;
    previewNote.textContent = link.dataset.note || "";
    galleryNavigation.hidden = gallery.length < 2;
    counter.textContent = `${currentImage + 1} / ${gallery.length}`;
  }

  function movePreview(direction) {
    currentImage = (currentImage + direction + gallery.length) % gallery.length;
    renderPreview();
  }

  previewLinks.forEach((link) => {
    link.addEventListener("click", (event) => {
      // Preserve normal browser actions such as opening the original image in a new tab.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const group = link.dataset.gallery || "projects";
      const uniqueImages = new Map();
      previewLinks.filter((item) => (item.dataset.gallery || "projects") === group)
        .forEach((item) => {
          if (!uniqueImages.has(item.href)) uniqueImages.set(item.href, item);
        });
      gallery = Array.from(uniqueImages.values());
      currentImage = gallery.findIndex((item) => item.href === link.href);
      renderPreview();
      preview.showModal();
      event.preventDefault();
    });
  });

  preview.querySelector(".dialog-close").addEventListener("click", () => preview.close());
  preview.querySelector("[data-preview-previous]").addEventListener("click", () => movePreview(-1));
  preview.querySelector("[data-preview-next]").addEventListener("click", () => movePreview(1));
  preview.addEventListener("keydown", (event) => {
    if (gallery.length > 1 && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      movePreview(event.key === "ArrowLeft" ? -1 : 1);
    }
  });
  preview.addEventListener("click", (event) => {
    const bounds = preview.getBoundingClientRect();
    if (event.target === preview && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) {
      preview.close();
    }
  });
}

const copyButton = document.querySelector("[data-copy-email]");
const copyStatus = document.querySelector(".copy-status");
const emailLink = document.querySelector(".contact-mail");
if (copyButton && copyStatus && emailLink && navigator.clipboard?.writeText) {
  copyButton.hidden = false;
  copyButton.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(emailLink.href.slice("mailto:".length).split("?")[0]);
      copyStatus.textContent = "E-Mail-Adresse kopiert.";
    } catch {
      copyStatus.textContent = "Bitte die E-Mail-Adresse markieren und kopieren.";
    }
  });
}

// YouTube erst nach Klick laden; das Vorschaubild bleibt gemerkt, falls die Version gewechselt wird
const trailerPosters = new WeakMap();
document.querySelectorAll("[data-load-trailer]").forEach((link) => {
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const box = link.closest(".trailer-player");
    const player = document.createElement("iframe");
    player.src = `https://www.youtube-nocookie.com/embed/${link.dataset.video}?autoplay=1&playsinline=1&rel=0`;
    player.title = `${link.dataset.videoTitle || "Trailer"} – YouTube-Video`;
    player.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    player.allowFullscreen = true;
    player.referrerPolicy = "strict-origin-when-cross-origin";
    trailerPosters.set(box, link);
    box.replaceChildren(player);
    player.focus();
  });
});

// Versionen umschalten (iQuest und iQuest Classic): Bild, Logo, Trailer und Text
document.querySelectorAll("[data-variants]").forEach((root) => {
  const buttons = root.querySelectorAll("[data-variant-switch]");
  const parts = root.querySelectorAll("[data-variant]");
  buttons.forEach((button) => button.addEventListener("click", () => {
    const name = button.dataset.variantSwitch;
    buttons.forEach((other) => other.setAttribute("aria-pressed", String(other === button)));
    parts.forEach((part) => { part.hidden = part.dataset.variant !== name; });
    // Ein laufender Trailer der anderen Version wird gestoppt
    root.querySelectorAll(".trailer-player").forEach((box) => {
      if (box.closest("[hidden]") && trailerPosters.has(box)) box.replaceChildren(trailerPosters.get(box));
    });
    root.classList.toggle("is-classic", name === "classic");
  }));
});

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const finePointer = window.matchMedia("(hover: hover) and (pointer: fine)").matches;

// Panels: Lichtkante folgt dem Zeiger.
if (finePointer && !reduceMotion) {
  document.querySelectorAll(".panel").forEach((panel) => {
    panel.addEventListener("pointermove", (event) => {
      const box = panel.getBoundingClientRect();
      panel.style.setProperty("--px", `${event.clientX - box.left}px`);
      panel.style.setProperty("--py", `${event.clientY - box.top}px`);
    });
    panel.addEventListener("pointerleave", () => {
      panel.style.removeProperty("--px");
      panel.style.removeProperty("--py");
    });
  });
}

// Charakterauswahl: leichte Tiefe mit dem Zeiger.
const hero = document.querySelector(".hero");
if (hero && finePointer && !reduceMotion) {
  hero.addEventListener("pointermove", (event) => {
    const box = hero.getBoundingClientRect();
    hero.style.setProperty("--mx", (((event.clientX - box.left) / box.width) * 2 - 1).toFixed(3));
    hero.style.setProperty("--my", (((event.clientY - box.top) / box.height) * 2 - 1).toFixed(3));
  });
  hero.addEventListener("pointerleave", () => {
    hero.style.setProperty("--mx", "0");
    hero.style.setProperty("--my", "0");
  });
}

// Erscheinen beim Scrollen.
const reveals = document.querySelectorAll(".reveal");
document.querySelectorAll(".track .node").forEach((node, index) => node.style.setProperty("--i", index));
document.querySelectorAll(".level-pips li").forEach((pip, index) => pip.style.setProperty("--i", index));
if ("IntersectionObserver" in window && !reduceMotion) {
  const revealer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add("is-in");
      revealer.unobserve(entry.target);
    });
  }, { threshold: 0.18, rootMargin: "0px 0px -8% 0px" });
  reveals.forEach((element) => revealer.observe(element));
} else {
  reveals.forEach((element) => element.classList.add("is-in"));
}

// Level-Karussell: aktive Welt, Pfeile, Reiter und Zähler.
const track = document.querySelector(".world-track");
if (track) {
  const worlds = Array.from(track.querySelectorAll(".world"));
  const tabs = Array.from(document.querySelectorAll(".world-tabs a"));
  const controls = document.querySelector(".carousel-controls");
  const current = document.querySelector("[data-world-current]");
  let active = 0;
  const setActive = (index) => {
    active = index;
    worlds.forEach((world, i) => world.classList.toggle("is-active", i === index));
    tabs.forEach((tab, i) => tab.classList.toggle("is-active", i === index));
    if (current) current.textContent = String(index + 1);
    document.dispatchEvent(new CustomEvent("welt:aktiv", { detail: worlds[index]?.id }));
  };
  const goTo = (index) => {
    const target = worlds[Math.max(0, Math.min(worlds.length - 1, index))];
    track.scrollTo({ left: target.offsetLeft - worlds[0].offsetLeft, behavior: reduceMotion ? "auto" : "smooth" });
  };
  setActive(0);
  if (controls) controls.hidden = false;
  document.querySelector("[data-world-prev]")?.addEventListener("click", () => goTo(active - 1));
  document.querySelector("[data-world-next]")?.addEventListener("click", () => goTo(active + 1));
  tabs.forEach((tab, index) => tab.addEventListener("click", (event) => {
    event.preventDefault();
    goTo(index);
  }));
  track.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      goTo(active + (event.key === "ArrowRight" ? 1 : -1));
    }
  });
  const pick = () => {
    const anchor = track.getBoundingClientRect().left + (worlds[0].offsetLeft - track.offsetLeft);
    let best = 0;
    let distance = Infinity;
    worlds.forEach((world, index) => {
      const gap = Math.abs(world.getBoundingClientRect().left - anchor);
      if (gap < distance) { distance = gap; best = index; }
    });
    if (best !== active) setActive(best);
  };
  let ticking = false;
  track.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { pick(); ticking = false; });
  }, { passive: true });
  // Links mit Vorschau in einer nicht aktiven Welt holen diese zuerst nach vorn.
  worlds.forEach((world, index) => world.addEventListener("focusin", () => { if (index !== active) setActive(index); }));
}

// Charakterleiste: Kim oder Maksim wählen (die 3D-Figur hört auf "figur:wahl")
const heroSelect = document.querySelector(".hero[data-character]");
const rosterSlots = document.querySelectorAll(".roster .slot[data-character]");
function showCharacter(id) {
  if (!heroSelect || !id) return;
  heroSelect.dataset.character = id;
  heroSelect.querySelectorAll("[data-for]").forEach((element) => { element.hidden = element.dataset.for !== id; });
  rosterSlots.forEach((slot) => {
    const active = slot.dataset.character === id;
    slot.classList.toggle("is-active", active);
    slot.setAttribute("aria-pressed", String(active));
  });
}
rosterSlots.forEach((slot) => slot.addEventListener("click", () => {
  if (slot.dataset.character === heroSelect?.dataset.character) return;
  showCharacter(slot.dataset.character);
  document.dispatchEvent(new CustomEvent("figur:wahl", { detail: slot.dataset.character }));
}));
document.addEventListener("figur:bereit", (event) => showCharacter(event.detail));
