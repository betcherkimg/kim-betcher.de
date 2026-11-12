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

// Zollstock im Hero: startet zusammengeklappt und klappt einmal beim Laden auf.
const ruler = document.querySelector(".ruler.is-folded");
if (ruler) {
  const unfold = () => ruler.classList.remove("is-folded");
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    unfold();
  } else {
    window.addEventListener("load", () => setTimeout(unfold, 250), { once: true });
    setTimeout(unfold, 2500);
  }
}
