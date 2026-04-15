# Chick-fil-A Dynamic Menu Prototype Spec

## Overview

This is a prototype for validating the pipeline before converting to production. The system pulls Chick-fil-A menu designs (JPG format) and uses agentic AI to convert them to dynamic HTML. The approach:

- Use the original image as a background
- Overlay dynamic price and calorie text at the correct positions
- Map text to the corresponding food item

Price and calorie data will be dynamic, changing based on which store the HTML is displayed in. This data will be provided as JSON. The AI must identify menu item names in the image to map each item's price and calories to the correct position. After generating designs, the application is pushed to screens across stores. The screen provides store ID and screen ID, which determines which design and dynamic data to display.

## General Guidelines

- This is a prototype; some existing code from another developer may be available
- Production front-end will use Angular
- Prototype can use vanilla JS if easier
- We can also just start by working with 1 screen design before doing 3 simoultaneously

## Pipeline Overview

**Source assets:**

- Menu designs are JPGs in Figma
- 3 menu designs total (one per possible screen position)
- Each design has two versions:
    - Blank version (no price/calorie text)
    - Example version (with price/calorie text filled in)

**Generation process:**

1. Claude Code pulls images from Figma via MCP
2. Claude Code analyzes the content
3. Claude Code produces an HTML version:
    - Displays the blank image as a full-size background
    - Overlays HTML text for prices and calories at correct positions
    - Text is dynamic (same design works across stores with different data)

**Deployment:**

- Full application is sent to all screens in all stores
- Each screen receives the same payload and code
- Screen provides data to identify:
    - Which store it's in
    - Which position it holds
- Application uses this to determine:
    - Which design to display
    - Which price/calorie data to show

## Data Structure

Expected format:

- JSON
- Keyed by store ID
- Each store contains:
    - Price per item (varies by store)
    - Calories per item (varies by store)
- 4 stores total
- Each store has 1–3 screens
- Each store has an ID corresponding to its screen configuration

## Question for Claude

What is the best way to structure the front-end application for initial prototyping to align with production needs? Expected prototype behavior: display one menu layout in HTML, with toggles to switch between stores/screens and see designs and data update accordingly.