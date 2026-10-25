import { AssetFlag } from '@immich/sdk';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import SearchFlagsSection from '$lib/components/shared-components/search-bar/SearchFlagsSection.svelte';

describe('SearchFlagsSection component', () => {
  const chip = (name: string) => screen.getByRole('button', { name });

  it('renders pick, reject and unflagged chips, none pressed by default', () => {
    render(SearchFlagsSection, { props: { selected: [] } });

    for (const name of ['flag_picked', 'flag_rejected', 'filter_unflagged']) {
      expect(chip(name).getAttribute('aria-pressed')).toBe('false');
    }
  });

  it('reflects the initial selection with aria-pressed', () => {
    render(SearchFlagsSection, { props: { selected: [AssetFlag.Pick, 'none'] } });

    expect(chip('flag_picked').getAttribute('aria-pressed')).toBe('true');
    expect(chip('filter_unflagged').getAttribute('aria-pressed')).toBe('true');
    expect(chip('flag_rejected').getAttribute('aria-pressed')).toBe('false');
  });

  it('toggles chips on and off, supporting multi-select and none', async () => {
    const user = userEvent.setup();
    const selected: Array<AssetFlag | 'none'> = [];
    render(SearchFlagsSection, { props: { selected } });

    await user.click(chip('flag_picked'));
    expect(chip('flag_picked').getAttribute('aria-pressed')).toBe('true');
    await user.click(chip('filter_unflagged'));
    expect(chip('filter_unflagged').getAttribute('aria-pressed')).toBe('true');
    expect(chip('flag_picked').getAttribute('aria-pressed')).toBe('true');

    await user.click(chip('flag_picked'));
    expect(chip('flag_picked').getAttribute('aria-pressed')).toBe('false');
    expect(chip('filter_unflagged').getAttribute('aria-pressed')).toBe('true');
  });
});
