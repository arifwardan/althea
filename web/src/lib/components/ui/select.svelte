<script>
  import { Select } from "bits-ui";
  import { cn } from "../../utils.js";

  let {
    value = $bindable(),
    options = [],
    placeholder = "Select…",
    label = "options",
    class: className = "",
    ...rest
  } = $props();
</script>

<Select.Root bind:value type="single" {...rest}>
  <Select.Trigger
    class={cn(
      "flex h-8 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm text-foreground focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50",
      className,
    )}
    aria-label={label}
  >
    <Select.Value {placeholder} class="truncate" />
  </Select.Trigger>
  <Select.Portal>
    <Select.Content
      class="z-50 min-w-36 overflow-hidden rounded-md border border-border bg-popover p-1 text-popover-foreground"
      sideOffset={4}
    >
      {#each options as o (o.value)}
        <Select.Item
          value={o.value}
          label={o.label}
          disabled={o.disabled}
          class="relative flex cursor-pointer items-center rounded-sm px-2 py-1.5 text-sm outline-none select-none data-disabled:pointer-events-none data-disabled:opacity-50 data-highlighted:bg-accent data-highlighted:text-accent-foreground data-selected:font-medium"
        >
          {o.label}
        </Select.Item>
      {/each}
    </Select.Content>
  </Select.Portal>
</Select.Root>
