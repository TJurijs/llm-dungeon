function element(tag, className, text) {
  const value = document.createElement(tag);
  if (className) value.className = className;
  if (text !== undefined) value.textContent = text;
  return value;
}

function stringValues(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim())
    : [];
}

function appendList(parent, heading, values, t) {
  const section = element("section");
  section.append(element("h4", "", heading));
  const items = stringValues(values);
  if (!items.length) {
    section.append(element("p", "inspection-empty", t("none")));
  } else {
    const list = element("ul", "inspection-list");
    for (const item of items) list.append(element("li", "", item));
    section.append(list);
  }
  parent.append(section);
}

export function traitParts(value) {
  const withoutId = value.replace(/^trait:[^:]+:\s*/, "").trim();
  const colonSeparator = withoutId.indexOf(": ");
  const dashSeparator = withoutId.indexOf(" — ");
  const separator =
    colonSeparator >= 0 && (dashSeparator < 0 || colonSeparator < dashSeparator)
      ? colonSeparator
      : dashSeparator;
  if (separator < 0) return { title: withoutId, description: "" };
  return {
    title: withoutId.slice(0, separator).trim(),
    description: withoutId.slice(separator + (separator === colonSeparator ? 2 : 3)).trim(),
  };
}

export function createTraitElement(value) {
  const { title, description } = traitParts(value);
  if (!description) {
    const staticTrait = element("div", "trait-item trait-item-static");
    staticTrait.append(element("h5", "trait-title", title));
    return staticTrait;
  }
  const trait = element("details", "trait-item");
  trait.append(
    element("summary", "trait-title", title),
    element("p", "trait-description", description),
  );
  return trait;
}

function appendTraits(parent, traits, t) {
  const section = element("section", "inspection-traits");
  section.append(element("h4", "", t("traits")));
  const items = stringValues(traits);
  if (!items.length) {
    section.append(element("p", "inspection-empty", t("none")));
  } else {
    const list = element("div", "trait-list");
    for (const item of items) {
      list.append(createTraitElement(item));
    }
    section.append(list);
  }
  parent.append(section);
}

function appendFacts(parent, facts, t, collapsible = false) {
  const values = [
    ...stringValues(facts?.established),
    ...stringValues(facts?.knowledge),
    ...stringValues(facts?.history),
  ];
  if (!collapsible) {
    appendList(parent, t("knownDetails"), values, t);
    return;
  }

  const section = element("section", "inspection-known-details-section");
  const details = element("details", "inspection-known-details");
  details.append(
    element("summary", "inspection-section-summary", `${t("knownDetails")} (${values.length})`),
  );
  if (!values.length) {
    details.append(element("p", "inspection-empty", t("none")));
  } else {
    const scroll = element("div", "known-details-scroll");
    const list = element("ul", "inspection-list");
    for (const item of values) list.append(element("li", "", item));
    scroll.append(list);
    details.append(scroll);
  }
  section.append(details);
  parent.append(section);
}

function header(inspection) {
  const value = element("header", "inspection-card-header");
  value.append(
    element("h3", "", inspection.name),
    element("span", "inspection-status", inspection.status),
  );
  return value;
}

function character(inspection, t) {
  const card = element("article", "inspection-card");
  card.append(header(inspection));
  appendList(card, t("description"), inspection.description ? [inspection.description] : [], t);
  appendTraits(card, inspection.traits, t);
  appendList(card, t("conditions"), inspection.conditions, t);
  const inventory = element("section");
  inventory.append(element("h4", "", t("inventory")));
  const items = Array.isArray(inspection.inventory) ? inspection.inventory : [];
  if (!items.length) {
    inventory.append(element("p", "inspection-empty", t("none")));
  } else {
    const list = element("ul", "inventory-list");
    for (const item of items) {
      const row = element("li", "inventory-item");
      row.append(element("strong", "", `${item.name} × ${item.quantity}`));
      if (item.status) row.append(element("p", "", item.status));
      if (item.description) row.append(element("p", "", item.description));
      list.append(row);
    }
    inventory.append(list);
  }
  card.append(inventory);
  appendList(
    card,
    t("relationships"),
    Array.isArray(inspection.relationships)
      ? inspection.relationships.map(
          (relationship) => `${relationship.name} — ${relationship.summary}`,
        )
      : [],
    t,
  );
  appendFacts(card, inspection.facts, t, true);
  return card;
}

function location(inspection, t) {
  const card = element("article", "inspection-card");
  card.append(header(inspection));
  appendList(card, t("description"), inspection.description ? [inspection.description] : [], t);
  appendList(card, t("features"), inspection.features, t);
  appendList(card, t("conditions"), inspection.conditions, t);
  appendFacts(card, inspection.facts, t);
  return card;
}

function threads(inspection, t) {
  const card = element("article", "inspection-card");
  const values = Array.isArray(inspection.threads) ? inspection.threads : [];
  for (const [status, heading] of [
    ["active", t("activeThreads")],
    ["resolved", t("resolvedThreads")],
    ["failed", t("failedThreads")],
  ]) {
    const section = element("section");
    section.append(element("h4", "", heading));
    const matching = values.filter((thread) => thread.status === status);
    if (!matching.length) {
      section.append(element("p", "inspection-empty", t("none")));
    } else {
      const list = element("ul", "thread-list");
      for (const thread of matching) {
        const item = element("li", "thread-item");
        item.append(element("strong", "", thread.title), element("p", "", thread.summary));
        list.append(item);
      }
      section.append(list);
    }
    card.append(section);
  }
  return card;
}

export function renderInspectionView(inspection, t) {
  if (inspection.view === "character") return character(inspection, t);
  if (inspection.view === "location") return location(inspection, t);
  if (inspection.view === "threads") return threads(inspection, t);
  throw new Error("Unknown inspection view");
}

export function inspectionMessage(text, mode = "status") {
  return element("p", `inspection-message ${mode}`, text);
}
