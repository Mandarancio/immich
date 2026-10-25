import { AssetColorLabel } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import ColorLabelPicker from '$lib/components/asset-viewer/ColorLabelPicker.svelte';
import { colorLabelClass } from '$lib/utils/color-label';

describe('ColorLabelPicker', () => {
  it('renders five color buttons with the color classes', () => {
    render(ColorLabelPicker, { value: null, onChange: vi.fn() });

    for (const label of Object.values(AssetColorLabel)) {
      const button = screen.getByRole('button', { name: `color_label_${label}` });
      expect(button.querySelector(`.${colorLabelClass[label]}`)).not.toBeNull();
    }
    expect(screen.getAllByRole('button')).toHaveLength(5);
  });

  it('emits the clicked color', async () => {
    const onChange = vi.fn();
    render(ColorLabelPicker, { value: null, onChange });

    await fireEvent.click(screen.getByRole('button', { name: 'color_label_red' }));

    expect(onChange).toHaveBeenCalledExactlyOnceWith(AssetColorLabel.Red);
  });

  it('emits null when the active color is clicked again', async () => {
    const onChange = vi.fn();
    render(ColorLabelPicker, { value: AssetColorLabel.Blue, onChange });

    const active = screen.getByRole('button', { name: 'color_label_blue' });
    expect(active.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'color_label_red' }).getAttribute('aria-pressed')).toBe('false');

    await fireEvent.click(active);

    expect(onChange).toHaveBeenCalledExactlyOnceWith(null);
  });

  it('disables the buttons when readOnly', async () => {
    const onChange = vi.fn();
    render(ColorLabelPicker, { value: AssetColorLabel.Green, onChange, readOnly: true });

    for (const button of screen.getAllByRole('button')) {
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    await fireEvent.click(screen.getByRole('button', { name: 'color_label_red' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});
