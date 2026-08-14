import assert from "node:assert/strict";
import { createStaffActionMenuController } from "../src/scripts/staff-action-menus.js";

class FakeRoot {
  constructor(menus) { this.menus = menus; this.listeners = new Map(); }
  querySelectorAll(selector) { return selector === "[data-staff-action-menu]" ? this.menus : []; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  dispatch(type, event) { this.listeners.get(type)?.(event); }
}

function menu() {
  const trigger = { focused: false, focus() { this.focused = true; } };
  const entry = {
    open: false,
    matches(selector) { return selector === "[data-staff-action-menu]"; },
    closest(selector) { return selector === "[data-staff-action-menu]" ? this : null; },
    querySelector(selector) { return selector === "summary" ? trigger : null; },
  };
  return { entry, trigger };
}

function targetFor(entry, { action = false } = {}) {
  return {
    closest(selector) {
      if (selector === "[data-staff-action-menu-item]") return action ? this : null;
      if (selector === "[data-staff-action-menu]") return entry;
      return null;
    },
  };
}

const first = menu();
const second = menu();
const root = new FakeRoot([first.entry, second.entry]);
createStaffActionMenuController(root);

first.entry.open = true;
root.dispatch("toggle", { target: first.entry });
assert.equal(first.entry.open, true, "opening a menu keeps it open");

second.entry.open = true;
root.dispatch("toggle", { target: second.entry });
assert.equal(first.entry.open, false, "opening menu B closes menu A");
assert.equal(second.entry.open, true, "menu B remains open");

root.dispatch("pointerdown", { target: { closest() { return null; } } });
assert.equal(second.entry.open, false, "an outside pointer closes the active menu");

first.entry.open = true;
root.dispatch("toggle", { target: first.entry });
let escapePrevented = false;
root.dispatch("keydown", { key: "Escape", preventDefault() { escapePrevented = true; } });
assert.equal(first.entry.open, false, "Escape closes the active menu");
assert.equal(first.trigger.focused, true, "Escape returns focus to the menu trigger");
assert.equal(escapePrevented, true, "Escape is handled by the action-menu controller");

second.entry.open = true;
root.dispatch("toggle", { target: second.entry });
root.dispatch("click", { target: targetFor(second.entry, { action: true }) });
assert.equal(second.entry.open, false, "selecting a row action closes its menu before page-specific work runs");

console.log("ok staff action-menu interaction controller");
