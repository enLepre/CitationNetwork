exports.chooseOption = async (page, selector, value) => {
  const select = page.locator(selector);
  // Historical fixtures may still use a native select.
  const trigger = page.locator(selector + '-trigger');
  if (!await trigger.count()) return select.selectOption(value);
  const text = await select.evaluate((el, value) => [...el.options].find(option => option.value === value).textContent, value);
  await trigger.click();
  const panel = page.locator(selector + '-panel');
  await panel.getByRole('option', { name: text, exact: true }).click();
};
