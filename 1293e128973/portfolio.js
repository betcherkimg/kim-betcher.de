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
      await navigator.clipboard.writeText(emailLink.href.slice("mailto:".length));
      copyStatus.textContent = "E-Mail-Adresse kopiert.";
    } catch {
      copyStatus.textContent = "Bitte die E-Mail-Adresse markieren und kopieren.";
    }
  });
}

document.querySelectorAll("[data-load-trailer]").forEach((link) => {
  link.addEventListener("click", (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const player = document.createElement("iframe");
    player.src = "https://www.youtube-nocookie.com/embed/m6fthG8m1qE?autoplay=1&playsinline=1&rel=0";
    player.title = "iQuest-Trailer – YouTube-Video";
    player.allow = "autoplay; encrypted-media; picture-in-picture; fullscreen";
    player.allowFullscreen = true;
    player.referrerPolicy = "strict-origin-when-cross-origin";
    link.closest(".trailer-player").replaceChildren(player);
    player.focus();
  });
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

// Schwebende Lichtpunkte in der Charakterauswahl.
const canvas = document.querySelector(".particles");
if (canvas && hero && !reduceMotion && canvas.getContext) {
  const context = canvas.getContext("2d");
  const colors = ["214, 255, 112", "142, 189, 255", "245, 243, 233"];
  let points = [];
  let running = false;
  let frame = 0;
  const resize = () => {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const count = Math.round(Math.min(70, canvas.clientWidth / 18));
    points = Array.from({ length: count }, () => ({
      x: Math.random() * canvas.clientWidth,
      y: Math.random() * canvas.clientHeight,
      r: 0.6 + Math.random() * 1.8,
      speed: 0.12 + Math.random() * 0.35,
      sway: Math.random() * Math.PI * 2,
      alpha: 0.15 + Math.random() * 0.5,
      color: colors[Math.floor(Math.random() * colors.length)]
    }));
  };
  const draw = () => {
    if (!running) return;
    frame += 1;
    context.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    for (const point of points) {
      point.y -= point.speed;
      point.x += Math.sin(frame / 90 + point.sway) * 0.18;
      if (point.y < -10) { point.y = canvas.clientHeight + 10; point.x = Math.random() * canvas.clientWidth; }
      context.beginPath();
      context.fillStyle = `rgba(${point.color}, ${point.alpha})`;
      context.shadowColor = `rgba(${point.color}, ${point.alpha})`;
      context.shadowBlur = 8;
      context.arc(point.x, point.y, point.r, 0, Math.PI * 2);
      context.fill();
    }
    requestAnimationFrame(draw);
  };
  resize();
  window.addEventListener("resize", resize);
  new IntersectionObserver(([entry]) => {
    const wasRunning = running;
    running = entry.isIntersecting && !document.hidden;
    if (running && !wasRunning) requestAnimationFrame(draw);
  }).observe(hero);
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
