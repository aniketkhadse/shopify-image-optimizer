# Shopify Image Optimizer App - Feature Overview

## 1. Core Functionality
- **Automated Image Scanning**:
    - Scans the Shopify store for product images.
    - **Prioritizes Newest Products**: Uses `sortKey: CREATED_AT, reverse: true` to ensure the most recently added products appear first.
    - **Auto-Load**: Automatically fetches scan results on page load/refresh, eliminating the need for a manual "Scan" button.
    - **Status Detection**: Distinguishes between "Optimized" and "Pending" images based on a local database record.

- **Image Optimization**:
    - **Compression**: Uses the `sharp` library to compress images (JPEG, 80% quality).
    - **Original Backup**: Stores the original image URL and size in the database before optimization.
    - **Savings Calculation**: Calculates and displays the size reduction (KB and %) for each image.
    - **Bulk Optimization**: "Optimize All Images" button processes pending images in a batch.
    - **Single Optimization**: Individual "Optimize" buttons for granular control.

- **Restore Functionality**:
    - **Restore Original**: Reverts the image to its original state using the backup.
    - **Smart State Management**: Updates the database record to "Pending" rather than deleting it, preserving the "Original Size" data for the UI.
    - **Bulk Restore**: "Restore All Images" button allows reverting changes globally.

## 2. User Interface (Dashboard)
- **Real-Time Statistics**:
    - **Total Images**: Count of all scanned images.
    - **Optimized / Pending**: Live counts of image status.
    - **Total Saved**: Aggregate storage savings in MB.
    - **Progress Bar**: Visual indicator of total optimization percentage.

- **Enhanced Navigation & Filtering**:
    - **Search Bar**: Real-time client-side search by Product Title or Alt Text.
    - **Filter**: Dropdown to show "All", "Pending", or "Optimized" images.
    - **Sort**: Sort by Default, Size (Largest first), or Savings (Most saved first).
    - **Pagination**: Client-side pagination (10 items per page) for easy browsing.

- **User Feedback**:
    - **Visual Badges**: 
        - 🟢 **Optimized**: Green badge with checkmark.
        - 🟡 **Pending**: Yellow badge with alert icon.
    - **Toast Notifications**: innovative feedback for actions like "Search complete", "Optimization started", "Restore successful".
    - **Loading States**: Buttons show loading spinners during async operations.

## 3. Technical Implementation
- **Backend**:
    - **Framework**: Remix (Node.js).
    - **Database**: SQLite (via Prisma ORM).
    - **Schema**: `ImageRecord` table stores `shopifyImageId`, `status`, `originalUrl`, `originalKb`, `optimizedKb`, `savingsKb`.
    - **ID Handling**: Handles Shopify's ID rotation by updating records with the new `finalGid` returned after an image update.

- **Frontend**:
    - **Library**: React (Remix).
    - **Design System**: Shopify Polaris (IndexTable, Cards, Badges, Toasts).
    - **State Management**: React `useState`, `useMemo` for filtering/sorting, and `useLoaderData` for initial data hydration.

## 4. Workflow
1.  **User Visits App**: The app `loader` automatically scans the shop and returns the image list tailored to newest products.
2.  **View Results**: User sees a dashboard with stats and a paginated list of images.
3.  **Action**: User searches for a product or filters by "Pending".
4.  **Optimize**: User clicks "Optimize" (Single or Bulk).
    - App compresses image -> Updates Shopify -> Updates DB -> UI updates to Green.
5.  **Restore**: User clicks "Restore".
    - App restores original -> Updates DB to Pending -> UI updates to Yellow (showing original size).

## 5. Error Checks & Resilience
- **Input Validation**: Checks if image exists before processing.
- **Fail-Safe**: If `restoreImage` logic changes, the database record is preserved to maintain history.
- **Persistence**: Optimized status persists across reloads; no "ghost" savings are shown for pending images.
