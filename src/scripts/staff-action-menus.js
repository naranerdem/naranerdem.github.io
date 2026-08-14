const menuSelector = "[data-staff-action-menu]";
const actionSelector = "[data-staff-action-menu-item]";

function menuFor(target) {
  return typeof target?.closest === "function" ? target.closest(menuSelector) : null;
}

/**
 * Coordinates the small row-action menus on a staff page without affecting
 * ordinary disclosure controls such as special schedule changes.
 */
export function createStaffActionMenuController(root = document) {
  let activeMenu = null;

  function close(menu = activeMenu, { returnFocus = false } = {}) {
    if (!menu) return;
    const trigger = menu.querySelector?.("summary");
    menu.open = false;
    if (activeMenu === menu) activeMenu = null;
    if (returnFocus) trigger?.focus?.();
  }

  function closeOtherMenus(menu) {
    for (const candidate of root.querySelectorAll(menuSelector)) {
      if (candidate !== menu) candidate.open = false;
    }
  }

  root.addEventListener("toggle", (event) => {
    const menu = menuFor(event.target);
    if (!menu) return;
    if (menu.open) {
      closeOtherMenus(menu);
      activeMenu = menu;
    } else if (activeMenu === menu) {
      activeMenu = null;
    }
  }, true);

  root.addEventListener("pointerdown", (event) => {
    if (!menuFor(event.target)) close();
  }, true);

  root.addEventListener("click", (event) => {
    const action = typeof event.target?.closest === "function" ? event.target.closest(actionSelector) : null;
    if (action) close(menuFor(action));
  }, true);

  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !activeMenu) return;
    event.preventDefault();
    close(activeMenu, { returnFocus: true });
  });

  return { close };
}
