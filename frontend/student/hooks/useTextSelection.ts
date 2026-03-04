import { useState, useRef, useEffect, useCallback } from 'react';

interface UseTextSelectionOptions {
  onClarify: (text: string, sourceId: string) => void;
}

export function useTextSelection({ onClarify }: UseTextSelectionOptions) {
  const [selectedText, setSelectedText] = useState('');
  const [selectedSourceAiMessageId, setSelectedSourceAiMessageId] = useState('');
  const [popupPosition, setPopupPosition] = useState<{ x: number; y: number } | null>(null);
  const savedRangeRef = useRef<Range | null>(null);
  const [pendingAutoSubmit, setPendingAutoSubmit] = useState(false);

  const handleTextSelection = useCallback(() => {
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed) {
      setPopupPosition(null);
      savedRangeRef.current = null;
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setPopupPosition(null);
      savedRangeRef.current = null;
      return;
    }
    let node = selection.anchorNode;
    let isInAiMessage = false;
    let aiMessageId = '';
    while (node) {
      if (node instanceof HTMLElement && node.dataset.aiMessage === 'true') {
        isInAiMessage = true;
        aiMessageId = node.dataset.messageId || '';
        break;
      }
      node = node.parentNode;
    }
    if (isInAiMessage) {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      savedRangeRef.current = range.cloneRange();
      setSelectedText(text);
      setSelectedSourceAiMessageId(aiMessageId);
      setPopupPosition({ x: rect.left + rect.width / 2, y: rect.top - 40 });
    } else {
      setPopupPosition(null);
      savedRangeRef.current = null;
    }
  }, []);

  const handleDontUnderstand = useCallback(() => {
    if (!selectedSourceAiMessageId) {
      setPopupPosition(null);
      savedRangeRef.current = null;
      return;
    }
    const truncated = selectedText.length > 100 ? selectedText.substring(0, 100) + '...' : selectedText;
    onClarify(truncated, selectedSourceAiMessageId);
    setPopupPosition(null);
    savedRangeRef.current = null;
    setPendingAutoSubmit(true);
  }, [selectedText, selectedSourceAiMessageId, onClarify]);

  // Restore selection after React render
  useEffect(() => {
    if (popupPosition && savedRangeRef.current) {
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(savedRangeRef.current);
      }
    }
  }, [popupPosition]);

  return {
    selectedText,
    selectedSourceAiMessageId,
    popupPosition,
    pendingAutoSubmit,
    setPendingAutoSubmit,
    handleTextSelection,
    handleDontUnderstand,
  };
}
