import { AssetColorLabel } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import SearchColorLabelsSection from '$lib/components/shared-components/search-bar/SearchColorLabelsSection.svelte';

describe('SearchColorLabelsSection component', () => {
  const chip = (name: string) => screen.getByRole('button', { name });

  it('renders five color chips and a no color chip, none pressed by default', () => {
    render(SearchColorLabelsSection, { props: { selected: [] } });

    for (const name of [
      'color_label_red',
      'color_label_yellow',
      'color_label_green',
      'color_label_blue',
      'color_label_purple',
      'filter_no_color',
    ]) {
      expect(chip(name).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('reflects the initial selection with aria-pressed', () => {
    render(SearchColorLabelsSection, { props: { selected: [AssetColorLabel.Red, 'none'] } });

    expect(chip('color_label_red').getAttribute('aria-pressed')).toBe('true');
    expect(chip('filter_no_color').getAttribute('aria-pressed')).toBe('true');
    expect(chip('color_label_blue').getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles chips on and off, supporting multi-select and none', async () => {
    const user = userEvent.setup();
    const selected: Array<AssetColorLabel | 'none'> = [];
    render(SearchColorLabelsSection, { props: { selected } });

    await user.click(chip('color_label_red'));
    expect(chip('color_label_red').getAttribute('aria-pressed')).toBe('true');
    await user.click(chip('filter_no_color'));
    expect(chip('filter_no_color').getAttribute('aria-pressed')).toBe('true');
    expect(chip('color_label_red').getAttribute('aria-pressed')).toBe('true');

    await user.click(chip('color_label_red'));
    expect(chip('color_label_red').getAttribute('aria-pressed')).toBe('false');
    expect(chip('filter_no_color').getAttribute('aria-pressed')).toBe('true');
  });
});
