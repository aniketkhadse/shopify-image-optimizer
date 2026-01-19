import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useActionData, useLoaderData, useNavigation, useSubmit, useFetcher } from "react-router";
import {
  Page,
  Layout,
  Card,
  Button,
  Text,
  BlockStack,
  IndexTable,
  Thumbnail,
  Badge,
  EmptyState,
  Toast,
  Frame,
  Banner,
  InlineStack,
  ProgressBar,
  Select,
  Spinner,
  FooterHelp,
  Link,
  Box,
  Divider,
  Icon,
  TextField,
  Pagination
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { optimizer } from "../services/optimizer.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  // REVERTED: This will scan the shop on load so you see images immediately.
  const results = await optimizer.scanShop(admin);

  return { results };
};

export const action = async ({ request }) => {
  if (request.method !== "POST") {
    throw new Response("Method Not Allowed", { status: 405 });
  }

  try {
    const { admin, session } = await authenticate.admin(request);
    const formData = await request.formData();
    const intent = formData.get("intent");

    console.log(`[Action] Intent: ${intent}`);

    if (intent === "scan") {
      const results = await optimizer.scanShop(admin);
      const agg = await prisma.imageRecord.aggregate({
        _count: { shopifyImageId: true },
        _sum: { savingsKb: true }
      });
      return Response.json({
        status: "success",
        type: "scan",
        results,
        stats: {
          totalOptimized: agg._count.shopifyImageId || 0,
          totalSavedKb: agg._sum.savingsKb || 0
        }
      });
    }

    if (intent === "optimize") {
      const itemData = formData.get("item");
      if (!itemData) {
        return Response.json({ status: "error", message: "Missing item data" });
      }
      const item = JSON.parse(itemData);
      const result = await optimizer.commitImage(admin, session, item);
      return Response.json({ status: "success", type: "commit", id: item.id, data: result });
    }

    if (intent === "restore") {
      const itemData = formData.get("item");
      if (!itemData) {
        return Response.json({ status: "error", message: "Missing item data" });
      }
      const item = JSON.parse(itemData);
      await optimizer.restoreImage(admin, session, item);
      return Response.json({ status: "success", type: "restore", id: item.id });
    }

    return Response.json({ status: "error", message: `Unknown intent: ${intent}` });
  } catch (error) {
    console.error("[Action Error]", error);
    return Response.json({ status: "error", message: `Server Error: ${error.message}` });
  }
};

export default function Index() {
  const loaderData = useLoaderData();
  const actionData = useActionData();
  const nav = useNavigation();
  const submit = useSubmit();
  const bulkFetcher = useFetcher();
  const bulkFetcherRef = useRef(bulkFetcher);

  useEffect(() => {
    bulkFetcherRef.current = bulkFetcher;
  }, [bulkFetcher]);

  // --- STATE ---
  const [scanResults, setScanResults] = useState(loaderData?.results || []);
  const [dbStats, setDbStats] = useState({ totalOptimized: 0, totalSavedKb: 0 });

  const [toastMessage, setToastMessage] = useState(null);
  const [isBulkOptimizing, setIsBulkOptimizing] = useState(false);
  const [isBulkRestoring, setIsBulkRestoring] = useState(false);
  const [bulkProgress, setBulkProgress] = useState({ current: 0, total: 0 });

  const stopBulkRef = useRef(false);
  const isMountedRef = useRef(false);
  const bulkRunIdRef = useRef(0);

  // CRITICAL: Track which images are being processed in current bulk run
  const processedIdsRef = useRef(new Set());
  const initialBulkStateRef = useRef(null);

  // Filters & Sorting
  const [filterStatus, setFilterStatus] = useState('all');
  const [sortOption, setSortOption] = useState('default');
  const [queryValue, setQueryValue] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;
  const [errorBanner, setErrorBanner] = useState(null);

  const toggleToast = useCallback(() => setToastMessage(null), []);
  const isScanning = nav.state === "submitting" && nav.formData?.get("intent") === "scan";

  // --- EFFECTS ---
  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      stopBulkRef.current = true;
    };
  }, []);

  // CRITICAL FIX: Only update from loader when NOT in bulk mode
  useEffect(() => {
    if (actionData?.status === "success" && actionData.type === "scan") {
      setScanResults(actionData.results || []);
      if (actionData.stats) setDbStats(actionData.stats);
      setIsBulkOptimizing(false);
      setIsBulkRestoring(false);
      setErrorBanner(null);
      processedIdsRef.current.clear();
      initialBulkStateRef.current = null;
    }
    if (actionData?.status === "error") {
      setErrorBanner(actionData.message);
      setIsBulkOptimizing(false);
      setIsBulkRestoring(false);
    }
  }, [actionData]);

  // CRITICAL FIX: Don't let loader resets override bulk processing state
  useEffect(() => {
    // If we're in bulk mode, preserve our local state and ignore loader updates
    if ((isBulkOptimizing || isBulkRestoring) && loaderData?.results) {
      console.log('[Bulk] Ignoring loader revalidation during bulk processing');
      return;
    }
    // Only update from loader when not in bulk mode
    if (!isBulkOptimizing && !isBulkRestoring && loaderData?.results) {
      setScanResults(loaderData.results);
    }
  }, [loaderData, isBulkOptimizing, isBulkRestoring]);

  useEffect(() => {
    setCurrentPage(1);
  }, [filterStatus, sortOption, queryValue]);

  // --- DERIVED STATE ---
  const filteredResults = useMemo(() => {
    let data = scanResults;

    if (queryValue) {
      const lower = queryValue.toLowerCase();
      data = data.filter(i =>
        (i.parentTitle && i.parentTitle.toLowerCase().includes(lower)) ||
        (i.alt && i.alt.toLowerCase().includes(lower))
      );
    }

    if (filterStatus === 'pending') data = data.filter(i => !i.optimized);
    if (filterStatus === 'optimized') data = data.filter(i => i.optimized);

    if (sortOption === 'size_desc') {
      data = [...data].sort((a, b) => (b.width * b.height) - (a.width * a.height));
    }
    if (sortOption === 'savings_desc') {
      data = [...data].sort((a, b) => (b.savedKb || 0) - (a.savedKb || 0));
    }

    return data;
  }, [scanResults, filterStatus, sortOption, queryValue]);

  const paginatedResults = filteredResults.slice(
    (currentPage - 1) * itemsPerPage,
    currentPage * itemsPerPage
  );

  const { sessionOptimizedCount, sessionPendingCount, sessionSavingsKb } = useMemo(() => {
    let optimizedCount = 0;
    let pendingCount = 0;
    let savingsKb = 0;

    for (const r of scanResults) {
      if (r.optimized) optimizedCount++;
      else pendingCount++;
      savingsKb += r.savedKb || 0;
    }

    return {
      sessionOptimizedCount: optimizedCount,
      sessionPendingCount: pendingCount,
      sessionSavingsKb: savingsKb,
    };
  }, [scanResults]);

  const displayStats = {
    totalImages: scanResults.length,
    optimizedConfig: sessionOptimizedCount,
    pendingConfig: sessionPendingCount,
    savings: sessionSavingsKb
  };

  const progressValue = displayStats.totalImages > 0
    ? (displayStats.optimizedConfig / displayStats.totalImages) * 100
    : 0;

  const isAllOptimized = scanResults.length > 0 && scanResults.every(r => r.optimized);

  // --- IMMEDIATE STATE UPDATE HELPER ---
  const updateImageState = useCallback((itemId, updates) => {
    setScanResults(prev => {
      const idx = prev.findIndex(r => r.id === itemId);
      if (idx === -1) return prev;

      const next = [...prev];
      next[idx] = { ...next[idx], ...updates };
      return next;
    });
  }, []);

  // --- OPTIMIZED BULK PROCESSOR ---
  // --- OPTIMIZED BULK PROCESSOR ---
  const runBulkQueue = useCallback(async (items, intent) => {
    const runId = ++bulkRunIdRef.current;
    stopBulkRef.current = false;
    processedIdsRef.current.clear();

    // Store initial state snapshot
    initialBulkStateRef.current = new Map(items.map(i => [i.id, { ...i }]));

    const queue = [...items];
    const CONCURRENCY = 1; // IMPORTANT: Keep at 1 for Shopify rate limits and RAM safety

    // Reset progress
    let processedCount = 0;
    let errorCount = 0;
    setBulkProgress({ current: 0, total: queue.length });

    // Helper: Submit via useFetcher and wait for result
    const submitBulk = (intent, item) => {
      return new Promise((resolve, reject) => {
        const fetcher = bulkFetcherRef.current;

        fetcher.submit(
          {
            intent,
            item: JSON.stringify(item),
          },
          {
            method: "POST",
            action: "/app?index", // Explicit action to hit index route
          }
        );

        // Poll for completion
        const check = setInterval(() => {
          const currentFetcher = bulkFetcherRef.current;
          if (currentFetcher.state === "idle" && currentFetcher.data) {
            clearInterval(check);
            if (currentFetcher.data.status === "success") {
              resolve(currentFetcher.data);
            } else {
              reject(new Error(currentFetcher.data.message || "Unknown error"));
            }
          }
        }, 50);

        // Safety timeout (30s)
        setTimeout(() => {
          clearInterval(check);
          reject(new Error("Timeout waiting for action response"));
        }, 30000);
      });
    };

    const processItem = async (item) => {
      // Check stop flag OR if a new run has started
      if (stopBulkRef.current || bulkRunIdRef.current !== runId) {
        return { skipped: true };
      }

      // CRITICAL: Skip if already processed in this run
      if (processedIdsRef.current.has(item.id)) {
        return { skipped: true };
      }

      try {
        const data = await submitBulk(intent, item);

        // CRITICAL: Mark as processed IMMEDIATELY
        processedIdsRef.current.add(item.id);

        if (intent === "optimize") {
          const beforeKb = data.data?.beforeKb || 0;
          const afterKb = data.data?.afterKb || 0;
          const savedKb = beforeKb - afterKb;
          const newId = data.data?.newId || item.id;

          updateImageState(item.id, {
            id: newId,
            optimized: true,
            originalKb: beforeKb,
            optimizedKb: afterKb,
            savedKb,
            // Calculate percent
            percent: beforeKb > 0
              ? Math.round(((beforeKb - afterKb) / beforeKb) * 100)
              : 0
          });
        }

        if (intent === "restore") {
          updateImageState(item.id, {
            optimized: false,
            savedKb: 0,
            optimizedKb: 0,
            percent: 0
          });
        }

        return { success: true };
      } catch (err) {
        console.error(`[Bulk Error] ${item.id}:`, err);
        return { error: err.message };
      }
    };

    // Process queue with proper concurrency control
    let activeRequests = 0;
    let queueIndex = 0;

    const worker = async () => {
      while (queueIndex < queue.length && !stopBulkRef.current && bulkRunIdRef.current === runId) {
        const currentIndex = queueIndex++;
        const item = queue[currentIndex];

        if (!item) break;

        activeRequests++;
        const result = await processItem(item);
        activeRequests--;

        if (result.skipped) continue;

        if (result.success) {
          processedCount++;
        } else if (result.error) {
          errorCount++;
        }

        // Update progress
        const currentProgress = processedCount + errorCount;
        setBulkProgress({ current: currentProgress, total: queue.length });
      }
    };

    // Start concurrent workers
    const workers = Array(CONCURRENCY).fill(null).map(() => worker());
    await Promise.all(workers);

    // Cleanup
    if (bulkRunIdRef.current !== runId || !isMountedRef.current) {
      return;
    }

    if (stopBulkRef.current) {
      setToastMessage(`Stopped. Processed: ${processedCount}, Errors: ${errorCount}`);
    } else {
      setToastMessage(`Complete! Processed: ${processedCount}, Errors: ${errorCount}`);
    }

    if (intent === "optimize") setIsBulkOptimizing(false);
    if (intent === "restore") setIsBulkRestoring(false);

    processedIdsRef.current.clear();
    initialBulkStateRef.current = null;
    setBulkProgress({ current: 0, total: 0 });
  }, [updateImageState]);

  const handleBulkOptimize = () => {
    if (isBulkOptimizing || isBulkRestoring) return;

    const pendingItems = scanResults.filter(i => !i.optimized);
    if (pendingItems.length === 0) {
      setToastMessage("All images are already optimized!");
      return;
    }

    setIsBulkOptimizing(true);
    setToastMessage(`Starting optimization for ${pendingItems.length} images...`);
    runBulkQueue(pendingItems, "optimize");
  };

  const handleBulkRestore = () => {
    if (isBulkOptimizing || isBulkRestoring) return;

    const optimizedItems = scanResults.filter(i => i.optimized);
    if (optimizedItems.length === 0) {
      setToastMessage("No optimized images to restore!");
      return;
    }

    setIsBulkRestoring(true);
    setToastMessage(`Restoring ${optimizedItems.length} images...`);
    runBulkQueue(optimizedItems, "restore");
  };

  const handleStop = useCallback(() => {
    stopBulkRef.current = true;
    setIsBulkOptimizing(false);
    setIsBulkRestoring(false);
    setToastMessage("Stopping bulk process...");
  }, []);

  const handleOptimizationSuccess = useCallback((itemId, beforeKb, afterKb) => {
    const savedKb = beforeKb - afterKb;
    updateImageState(itemId, {
      optimized: true,
      originalKb: beforeKb,
      optimizedKb: afterKb,
      savedKb,
      percent: beforeKb > 0 ? Math.round((savedKb / beforeKb) * 100) : 0
    });
  }, [updateImageState]);

  const handleRestore = useCallback((itemId) => {
    updateImageState(itemId, {
      optimized: false,
      savedKb: 0,
      optimizedKb: 0,
      percent: 0
    });
  }, [updateImageState]);

  return (
    <Frame>
      <Page title="Arista Image Optimizer (Free V1)" compactTitle>
        <Layout>
          {errorBanner && (
            <Layout.Section>
              <Banner tone="critical" onDismiss={() => setErrorBanner(null)}>
                <p>{errorBanner}</p>
              </Banner>
            </Layout.Section>
          )}

          {/* BULK PROGRESS BANNER */}
          {(isBulkOptimizing || isBulkRestoring) && bulkProgress.total > 0 && (
            <Layout.Section>
              <Banner tone="info">
                <BlockStack gap="200">
                  <Text variant="bodyMd" fontWeight="bold">
                    {isBulkOptimizing ? 'Optimizing' : 'Restoring'} images... {bulkProgress.current} / {bulkProgress.total}
                  </Text>
                  <ProgressBar
                    progress={(bulkProgress.current / bulkProgress.total) * 100}
                    tone="primary"
                    size="small"
                  />
                  <Text variant="bodySm" tone="subdued">
                    Processing with {5} concurrent requests. Do not close this page.
                  </Text>
                </BlockStack>
              </Banner>
            </Layout.Section>
          )}

          {/* SUMMARY SECTION */}
          <Layout.Section>
            <Card>
              <BlockStack gap="400">
                <Text variant="headingMd" as="h2">Overview</Text>
                <InlineStack align="space-between" gap="400">
                  <StatItem label="Total Images" value={displayStats.totalImages} />
                  <StatItem label="Optimized" value={displayStats.optimizedConfig} color="success" />
                  <StatItem label="Pending" value={displayStats.pendingConfig} color="attention" />
                  <StatItem label="Total Saved" value={`${(displayStats.savings / 1024).toFixed(2)} MB`} />
                </InlineStack>
                <Box paddingBlockStart="200">
                  <BlockStack gap="200">
                    <InlineStack align="space-between">
                      <Text variant="bodySm" tone="subdued">Optimization Progress</Text>
                      <Text variant="bodySm" tone="subdued">{Math.round(progressValue)}%</Text>
                    </InlineStack>
                    <ProgressBar progress={progressValue} tone="primary" size="small" />
                    <Text variant="bodyXs" tone="subdued">You can restore original images anytime with one click.</Text>
                  </BlockStack>
                </Box>
              </BlockStack>
            </Card>
          </Layout.Section>

          {/* MAIN ACTIONS & TABLE */}
          <Layout.Section>
            {sessionOptimizedCount > 0 && (
              <Box paddingBlockEnd="400">
                <Card>
                  <BlockStack gap="200">
                    <Text variant="headingSm" as="h3">Restore Original Images</Text>
                    <Text variant="bodyMd">All original images are safely backed up. You can restore them anytime.</Text>
                    <InlineStack gap="200">
                      <Button onClick={handleBulkRestore} disabled={isBulkRestoring || isBulkOptimizing} loading={isBulkRestoring}>
                        Restore All Images
                      </Button>
                      {isBulkRestoring && <Button onClick={handleStop} tone="critical">Stop</Button>}
                    </InlineStack>
                  </BlockStack>
                </Card>
              </Box>
            )}

            <Card padding="0">
              <Box padding="400">
                <BlockStack gap="400">
                  <InlineStack align="space-between" blockAlign="center">
                    <InlineStack gap="200">
                      <Button
                        variant="primary"
                        onClick={() => submit({ intent: "scan" }, { method: "POST" })}
                        loading={isScanning}
                        disabled={isBulkOptimizing || isAllOptimized || isBulkRestoring}
                      >
                        {scanResults.length > 0 ? "Rescan Shop" : "Scan Shop Images"}
                      </Button>

                      {scanResults.length > 0 && !isAllOptimized && (
                        <InlineStack gap="200">
                          {!isBulkOptimizing ? (
                            <Button onClick={handleBulkOptimize} disabled={sessionPendingCount === 0 || isBulkRestoring} tone="success">
                              Optimize All Images ({sessionPendingCount})
                            </Button>
                          ) : (
                            <Button onClick={handleStop} tone="critical">Stop Optimization</Button>
                          )}
                        </InlineStack>
                      )}
                    </InlineStack>
                  </InlineStack>

                  {scanResults.length > 0 && (
                    <InlineStack gap="200">
                      <div style={{ width: '200px' }}>
                        <TextField
                          placeholder="Search images..."
                          value={queryValue}
                          onChange={setQueryValue}
                          clearButton
                          onClearButtonClick={() => setQueryValue("")}
                          autoComplete="off"
                        />
                      </div>
                      <div style={{ width: '150px' }}>
                        <Select
                          label="Filter"
                          labelHidden
                          options={[
                            { label: 'All Status', value: 'all' },
                            { label: 'Pending', value: 'pending' },
                            { label: 'Optimized', value: 'optimized' },
                          ]}
                          value={filterStatus}
                          onChange={setFilterStatus}
                          disabled={isBulkOptimizing || isBulkRestoring}
                        />
                      </div>
                      <div style={{ width: '150px' }}>
                        <Select
                          label="Sort"
                          labelHidden
                          options={[
                            { label: 'Default', value: 'default' },
                            { label: 'Size (Desc)', value: 'size_desc' },
                            { label: 'Savings (Desc)', value: 'savings_desc' },
                          ]}
                          value={sortOption}
                          onChange={setSortOption}
                          disabled={isBulkOptimizing || isBulkRestoring}
                        />
                      </div>
                    </InlineStack>
                  )}
                </BlockStack>
              </Box>
              <Divider />

              {scanResults.length === 0 && !isScanning && (
                <Box padding="800">
                  <EmptyState
                    heading="No scan results"
                    image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                  >
                    <p>Click "Scan Shop Images" to analyze your store.</p>
                  </EmptyState>
                </Box>
              )}

              {scanResults.length > 0 && (
                <IndexTable
                  resourceName={{ singular: "image", plural: "images" }}
                  itemCount={filteredResults.length}
                  pagination={{
                    hasNext: currentPage * itemsPerPage < filteredResults.length,
                    hasPrevious: currentPage > 1,
                    onNext: () => setCurrentPage(c => c + 1),
                    onPrevious: () => setCurrentPage(c => c - 1),
                    label: `${(currentPage - 1) * itemsPerPage + 1}-${Math.min(currentPage * itemsPerPage, filteredResults.length)} of ${filteredResults.length}`
                  }}
                  headings={[
                    { title: "Preview" },
                    { title: "Details" },
                    { title: "Stats" },
                    { title: "Status" },
                    { title: "Action" }
                  ]}
                  selectable={false}
                >
                  {paginatedResults.map((item, i) => (
                    <ImageRow
                      key={item.id}
                      item={item}
                      position={i}
                      isBulkOptimizing={isBulkOptimizing}
                      isBulkRestoring={isBulkRestoring}
                      onSuccess={handleOptimizationSuccess}
                      onRestore={handleRestore}
                      onError={(msg) => setToastMessage(`Error: ${msg}`)}
                    />
                  ))}
                </IndexTable>
              )}
            </Card>
          </Layout.Section>

          <Layout.Section>
            <FooterHelp>
              Arista Image Optimizer – Free V1. Unlimited optimization. <Link url="#">Need help?</Link>
            </FooterHelp>
          </Layout.Section>

        </Layout>
        {toastMessage && <Toast content={toastMessage} onDismiss={toggleToast} />}
      </Page>
    </Frame>
  );
}

function StatItem({ label, value, color }) {
  return (
    <BlockStack gap="100">
      <Text variant="bodySm" tone="subdued">{label}</Text>
      <Text variant="headingLg" tone={color}>{value}</Text>
    </BlockStack>
  );
}

function ImageRow({ item, position, isBulkOptimizing, isBulkRestoring, onSuccess, onRestore, onError }) {
  const fetcher = useFetcher();
  const isSubmitting = fetcher.state === "submitting" || fetcher.state === "loading";
  const isOptimized = item.optimized;

  useEffect(() => {
    if (fetcher.data?.status === "success") {
      if (fetcher.data.type === 'commit') {
        const { id, data } = fetcher.data;
        if (id === item.id) onSuccess(id, data.beforeKb, data.afterKb);
      }
      if (fetcher.data.type === 'restore') {
        if (fetcher.data.id === item.id) onRestore(fetcher.data.id);
      }
    }
    if (fetcher.data?.status === "error") {
      onError(fetcher.data.message);
    }
  }, [fetcher.data]);

  return (
    <IndexTable.Row id={item.id} key={item.id} position={position}>
      <IndexTable.Cell>
        <div style={{ height: '50px', width: '50px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Thumbnail source={item.url} alt={item.alt} size="small" />
        </div>
      </IndexTable.Cell>
      <IndexTable.Cell>
        <BlockStack>
          <Text fontWeight="bold" truncate>{item.parentTitle}</Text>
          <Text color="subdued" variant="bodySm">{item.width}x{item.height}</Text>
        </BlockStack>
      </IndexTable.Cell>

      <IndexTable.Cell>
        {isOptimized ? (
          <BlockStack gap="050">
            <Text variant="bodySm" tone="success">Saved {item.percent}%</Text>
            <Text variant="bodyXs" tone="subdued">{item.originalKb}KB → {item.optimizedKb}KB</Text>
          </BlockStack>
        ) : (
          item.originalKb > 0 ? (
            <Text variant="bodySm" tone="subdued">Original: {item.originalKb} KB</Text>
          ) : (
            <Text variant="bodySm" tone="subdued">Ready to optimize</Text>
          )
        )}
      </IndexTable.Cell>

      <IndexTable.Cell>
        {isOptimized ? <Badge tone="success">Optimized</Badge> : <Badge tone="attention">Pending</Badge>}
      </IndexTable.Cell>

      <IndexTable.Cell>
        {isOptimized ? (
          <Button
            onClick={() => fetcher.submit({ intent: "restore", item: JSON.stringify(item) }, { method: "POST" })}
            size="slim"
            variant="plain"
            disabled={isSubmitting || isBulkOptimizing || isBulkRestoring}
            loading={isSubmitting}
          >
            Restore
          </Button>
        ) : (
          <Button
            onClick={() => fetcher.submit({ intent: "optimize", item: JSON.stringify(item) }, { method: "POST" })}
            size="slim"
            variant="primary"
            tone="success"
            loading={isSubmitting}
            disabled={isSubmitting || isBulkOptimizing || isBulkRestoring}
          >
            Optimize
          </Button>
        )}
      </IndexTable.Cell>
    </IndexTable.Row>
  );
}