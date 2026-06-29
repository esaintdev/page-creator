import zipfile, io, re, os, glob

KEYWORDS = ['Airport', 'Chauffeur', 'Service', 'Transfer', 'Pickup', 'Hire', 'Travel', 'Journey', 'Luxury']
KW_PATTERN = re.compile(r'\b(?:' + '|'.join(KEYWORDS) + r')\b')
KNOWN_PREFIXES = ['Luxury', 'Luxurious', 'Premier', 'Executive', 'Exclusive', 'Premium', 'Professional', 'Ultimate']
PREFIX_RE = re.compile(r'^(?:' + '|'.join(KNOWN_PREFIXES) + r')\s+', re.I)

def get_para_texts(xml):
    """Return list of (full_text, para_xml) for each paragraph."""
    paras = re.findall(r'<w:p[^>]*>.*?</w:p>', xml, re.DOTALL)
    result = []
    for p in paras:
        texts = re.findall(r'<w:t[^>]*>(.*?)</w:t>', p)
        result.append((''.join(texts).strip(), p))
    return result

def set_para_text(para_xml, new_text):
    """Change the text content inside a paragraph's first <w:t> tag."""
    return re.sub(r'(<w:t[^>]*>)(.*?)(</w:t>)', lambda m: m.group(1) + new_text + m.group(3), para_xml, count=1)

def extract_vehicle(heading):
    """Extract vehicle name: strip known prefixes, take text before first keyword."""
    cleaned = PREFIX_RE.sub('', heading)
    m = KW_PATTERN.search(cleaned)
    if not m:
        return cleaned.strip()
    vehicle = cleaned[:m.start()].strip()
    # If nothing remains, try extracting after location and before next keyword
    if not vehicle:
        loc_m = re.search(r'\b(?:from|to)\s+(.+?)\b', heading, re.I)
        if loc_m:
            after_loc = heading[loc_m.end():].strip()
            kw_m = KW_PATTERN.search(after_loc)
            if kw_m:
                vehicle = after_loc[:kw_m.start()].strip()
            else:
                vehicle = after_loc
    return vehicle

def extract_location(heading):
    """Extract location: text after 'from' or 'to', before next keyword."""
    m = re.search(r'\b(?:from|to)\s+(.+?)\b', heading, re.I)
    if m:
        loc = m.group(1).strip()
        # Trim at next keyword if present
        kw_m = KW_PATTERN.search(loc)
        if kw_m:
            loc = loc[:kw_m.start()].strip()
        return loc
    return ''

docs_dir = os.path.join(os.path.dirname(__file__), 'documents')
docx_files = glob.glob(os.path.join(docs_dir, '*.docx')) + glob.glob(os.path.join(docs_dir, '*.DOCX'))
docx_files = [f for f in docx_files if not os.path.basename(f).startswith('.')]

if not docx_files:
    print("No .docx files found in documents/")
    exit()

print(f"Found {len(docx_files)} file(s)\n")

for docx_path in sorted(docx_files):
    name = os.path.basename(docx_path)
    buf = io.BytesIO()
    with open(docx_path, 'rb') as f:
        buf.write(f.read())

    xml = None
    with zipfile.ZipFile(buf, 'r') as z:
        xml = z.read('word/document.xml').decode('utf-8')

    changes = []

    # ── 1. Fix Meta SEO Description ──
    if 'Meta SEO Description:' in xml:
        xml = xml.replace('Meta SEO Description:', 'Meta Description:')
        changes.append('Meta SEO -> Meta Description')

    # ── 2. Remove empty Additional Keyword ──
    paras = re.findall(r'<w:p[^>]*>.*?</w:p>', xml, re.DOTALL)
    for i, p in enumerate(paras):
        texts = re.findall(r'<w:t[^>]*>(.*?)</w:t>', p)
        full = ''.join(texts).strip()
        if full == 'Additional Keyword:':
            for j in range(i+1, len(paras)):
                jtexts = re.findall(r'<w:t[^>]*>(.*?)</w:t>', paras[j])
                jfull = ''.join(jtexts).strip()
                if jfull == 'Additional Keyword:':
                    xml = xml.replace(p, '', 1)
                    changes.append('Removed empty Additional Keyword')
                    break
                elif jfull:
                    break
        if 'Removed empty Additional Keyword' in changes:
            break

    # ── 3. Rewrite page title (only if title lacks with/by/in) ──
    para_info = get_para_texts(xml)

    # Find Page Title: label, its value paragraph, and current title text
    title_label_idx = None
    title_value_para = None
    current_title = ''
    for i, (txt, p) in enumerate(para_info):
        if txt == 'Page Title:':
            title_label_idx = i
            for j in range(i+1, len(para_info)):
                if para_info[j][0]:
                    title_value_para = para_info[j][1]
                    current_title = para_info[j][0]
                    break
            break

    # Find Meta Description: label to locate body start
    body_start_idx = None
    for i, (txt, p) in enumerate(para_info):
        if txt.startswith('Meta Description:'):
            body_start_idx = i
            break

    # Find Section 1 heading (first heading after Meta Description)
    section1_heading = None
    if body_start_idx is not None:
        for i in range(body_start_idx + 1, len(para_info)):
            txt = para_info[i][0]
            if txt and len(txt) < 100 and not re.search(r'[.!:]$', txt):
                section1_heading = txt
                break

    # Only rewrite if title doesn't already have with|by|in
    title_has_prep = bool(re.search(r'\b(?:with|by|in)\b', current_title, re.I))
    if not title_has_prep and section1_heading and title_value_para:
        vehicle = extract_vehicle(section1_heading)
        location = extract_location(section1_heading)
        if vehicle:
            new_title = f'Luxury Airport Transfer from {location} by {vehicle}' if location else f'Luxury Airport Transfer by {vehicle}'
            # Find and update the title value paragraph in the XML
            old_para_xml = title_value_para
            new_para_xml = set_para_text(old_para_xml, new_title)
            xml = xml.replace(old_para_xml, new_para_xml, 1)
            changes.append(f'Title: {new_title}')

    if not changes:
        print(f"  {name} — no changes needed")
        continue

    # ── Write back ──
    out_buf = io.BytesIO()
    with zipfile.ZipFile(out_buf, 'w', zipfile.ZIP_DEFLATED) as zout:
        with zipfile.ZipFile(buf, 'r') as zin:
            for item in zin.infolist():
                if item.filename == 'word/document.xml':
                    zout.writestr(item, xml.encode('utf-8'))
                else:
                    zout.writestr(item, zin.read(item.filename))

    with open(docx_path, 'wb') as f:
        f.write(out_buf.getvalue())

    print(f"  {name} — {'; '.join(changes)}")

print("\nDone")
