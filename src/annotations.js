import Gtk from 'gi://Gtk'
import Gio from 'gi://Gio'
import GObject from 'gi://GObject'
import { gettext as _ } from 'gettext'
import * as utils from './utils.js'
import * as CFI from './foliate-js/epubcfi.js'

const Bookmark = utils.makeDataClass('FoliateBookmark', {
    'value': 'string',
    'label': 'string',
})

const Annotation = utils.makeDataClass('FoliateAnnotation', {
    'value': 'string',
    'color': 'string',
    'text': 'string',
    'note': 'string',
})

const AnnotationHeading = utils.makeDataClass('FoliateAnnotationHeading', {
    'label': 'string',
    'index': 'uint',
    'subitems': 'object',
})

const BookmarkRow = GObject.registerClass({
    GTypeName: 'FoliateBookmarkRow',
    Template: pkg.moduleuri('ui/bookmark-row.ui'),
    Children: ['button'],
    InternalChildren: ['label', 'value'],
}, class extends Gtk.Box {
    update({ value, label }) {
        this.value = value
        this._label.label = label
        this._value.label = value
    }
})

const AnnotationRow = GObject.registerClass({
    GTypeName: 'FoliateAnnotationRow',
    Template: pkg.moduleuri('ui/annotation-row.ui'),
    InternalChildren: ['heading', 'box', 'color', 'text', 'note'],
}, class extends Gtk.Box {
    update(obj) {
        if (obj instanceof Annotation) {
            const { text, note, color } = obj
            this._text.label = text.replace(/\n/g, ' ')
            this._note.label = note.replace(/\n/g, ' ')
            this._color.update(color)
            this._heading.hide()
            this._box.show()
            if (note) this._note.show()
            else this._note.hide()
            this.margin_top = 6
            this.margin_bottom = 6
        } else {
            this._heading.label = obj.label
            this._heading.show()
            this._box.hide()
            this._note.hide()
            this.margin_top = 3
            this.margin_bottom = 3
        }
    }
})

GObject.registerClass({
    GTypeName: 'FoliateBookmarkView',
    Properties: utils.makeParams({
        'has-items': 'boolean',
        'has-items-in-view': 'boolean',
    }),
    Signals: {
        'go-to-bookmark': { param_types: [GObject.TYPE_STRING] },
    },
}, class extends Gtk.ListView {
    #location
    #inView = []
    constructor(params) {
        super(params)
        this.model = new Gtk.NoSelection({ model: new Gio.ListStore() })
        this.model.model.connect('notify::n-items', model =>
            this.set_property('has-items', model.get_n_items() > 0))
        this.connect('activate', (_, pos) => {
            const bookmark = this.model.model.get_item(pos) ?? {}
            if (bookmark) this.emit('go-to-bookmark', bookmark.value)
        })
        this.factory = utils.connect(new Gtk.SignalListItemFactory(), {
            'setup': (_, listItem) => {
                const row = new BookmarkRow()
                row.button.connect('clicked', () => {
                    this.delete(row.value)
                    this.updateLocation()
                })
                listItem.child = row
            },
            'bind': (_, listItem) => listItem.child.update(listItem.item),
        })
    }
    add(value, label) {
        this.model.model.append(new Bookmark({ value, label }))
    }
    delete(value) {
        const { model } = this.model
        for (const [i, item] of utils.gliter(model))
            if (item.value === value) model.remove(i)
    }
    updateLocation(location = this.#location) {
        this.#location = location
        const { cfi } = location
        const start = CFI.collapse(cfi)
        const end = CFI.collapse(cfi, true)
        this.#inView = Array.from(utils.gliter(this.model.model),
            ([, { value }]) => [value,
                CFI.compare(start, value) * CFI.compare(end, value) <= 0])
            .filter(([, x]) => x)
        this.set_property('has-items-in-view', this.#inView.length > 0)
    }
    toggle() {
        const inView = this.#inView
        if (inView.length) for (const [value] of inView) this.delete(value)
        else this.add(this.#location.cfi, this.#location.tocItem?.label)
        this.updateLocation()
    }
    clear() {
        this.model.model.remove_all()
    }
})

export const AnnotationModel = GObject.registerClass({
    GTypeName: 'FoliateAnnotationModel',
    Properties: utils.makeParams({
        'has-items': 'boolean',
    }),
    Signals: {
        'update-annotation': { param_types: [Annotation.$gtype] },
    },
}, class extends Gio.ListStore {
    #map = new Map()
    #lists = new Map()
    #connections = new WeakMap()
    constructor(params) {
        super(params)
        this.connect('notify::n-items', model =>
            this.set_property('has-items', model.get_n_items() > 0))
    }
    add(annotation, index, label) {
        const { value } = annotation
        if (this.#map.has(value)) return
        const obj = annotation instanceof Annotation
            ? new Annotation(annotation.toJSON()) : new Annotation(annotation)
        this.#map.set(value, obj)
        obj.connectAll(() => this.emit('update-annotation', obj))
        if (this.#lists.has(index)) {
            const list = this.#lists.get(index)
            for (const [i, item] of utils.gliter(list)) {
                if (CFI.compare(value, item.value) <= 0) {
                    list.insert(i, obj)
                    return
                }
            }
            list.append(obj)
        } else {
            const subitems = new Gio.ListStore()
            subitems.append(obj)
            this.#lists.set(index, subitems)
            const heading = new AnnotationHeading({ label, index, subitems })
            for (const [i, item] of utils.gliter(this))
                if (item.index > index) return this.insert(i, heading)
            this.append(heading)
        }
    }
    delete(annotation, index) {
        const { value } = annotation
        this.#map.delete(value)
        const list = this.#lists.get(index)
        for (const [i, item] of utils.gliter(list)) {
            if (item.value === value) {
                list.remove(i)
                if (!list.get_n_items()) {
                    for (const [j, item] of utils.gliter(this))
                        if (item.subitems === list) {
                            this.remove(j)
                            this.#lists.delete(index)
                            break
                        }
                }
                break
            }
        }
    }
    get(value) {
        return this.#map.get(value)
    }
    getForIndex(index) {
        return this.#lists.get(index)
    }
    export() {
        return Array.from(utils.gliter(this), ([, item]) =>
            Array.from(utils.gliter(item.subitems), ([, item]) => item)).flat()
    }
    connect_(object, obj) {
        if (this.#connections.has(object)) return
        this.#connections.set(object, Array.from(Object.entries(obj),
            ([key, val]) => this.connect(key, val)))
        return this
    }
    disconnect_(object) {
        const handlers = this.#connections.get(object)
        if (handlers) for (const id of handlers) this.disconnect(id)
    }
})

GObject.registerClass({
    GTypeName: 'FoliateAnnotationView',
    Signals: {
        'go-to-annotation': { param_types: [Annotation.$gtype] },
    },
}, class extends Gtk.ListView {
    #filter
    constructor(params) {
        super(params)
        this.connect('activate', (_, pos) => {
            const annotation = this.model.model.get_item(pos).item ?? {}
            if (annotation) this.emit('go-to-annotation', annotation)
        })
        const handlers = new WeakMap()
        this.factory = utils.connect(new Gtk.SignalListItemFactory(), {
            'setup': (_, listItem) => {
                listItem.child = new Gtk.TreeExpander({ indent_for_icon: false })
                listItem.child.child = new AnnotationRow()
            },
            'bind': (_, listItem) => {
                const expander = listItem.child
                expander.list_row = listItem.item

                const annotation = listItem.item.item
                const widget = expander.child
                widget.update(annotation)
                handlers.set(listItem, annotation.connectAll(() =>
                    widget.update(annotation)))

                const ctx = expander.get_style_context()
                if (annotation.subitems) ctx.add_class('dim-label')
                else ctx.remove_class('dim-label')
            },
            'unbind': (_, listItem) =>
                utils.disconnect(listItem.item.item, handlers.get(listItem)),
        })
    }
    setupModel(model) {
        const tree = Gtk.TreeListModel
            .new(model, false, true, item => item.subitems ?? null)
        this.#filter = new Gtk.FilterListModel({ model: tree })
        this.model = new Gtk.NoSelection({ model: this.#filter })
    }
    filter(query) {
        query = query?.trim()?.toLowerCase()
        const filter = new Gtk.CustomFilter()
        filter.set_filter_func(query ? row => {
            const { item } = row
            const { text, color, note } = item
            return [text, color, note].some(x => x?.toLowerCase()?.includes(query))
        } : null)
        this.#filter.filter = filter
    }
})

const AnnotationColor = utils.makeDataClass('FoliateAnnotationColor', {
    'label': 'string',
    'value': 'string',
    'type': 'string',
})

const AnnotationColorImage = GObject.registerClass({
    GTypeName: 'FoliateAnnotationColorImage',
}, class extends Gtk.Stack {
    #icon = new Gtk.Image()
    #frame = new Gtk.Frame({
        width_request: 16,
        height_request: 16,
        valign: Gtk.Align.CENTER,
    })
    constructor(params) {
        super(params)
        this.add_child(this.#icon)
        this.add_child(this.#frame)
    }
    update(color) {
        if (color === 'underline') {
            this.#icon.icon_name = 'format-text-underline-symbolic'
            this.visible_child = this.#icon
        } else if (color) {
            utils.addStyle(this.#frame, `frame {
                background: ${utils.RGBA(color).to_string()};
            }`)
            this.visible_child = this.#frame
        } else {
            this.#icon.icon_name = 'color-select-symbolic'
            this.visible_child = this.#icon
        }
    }
})

const AnnotationColorRow = GObject.registerClass({
    GTypeName: 'FoliateAnnotationColorRow',
    Properties: utils.makeParams({
        'dropdown': 'object',
    }),
}, class extends Gtk.Box {
    #color
    #image = new AnnotationColorImage()
    #label = new Gtk.Label()
    #checkmark = new Gtk.Image({
        visible: false,
        icon_name: 'object-select-symbolic',
    })
    constructor(params) {
        super(params)
        this.spacing = 6
        this.append(this.#image)
        this.append(this.#label)
        this.append(this.#checkmark)
        if (this.dropdown)
            this.dropdown.connect('notify::selected-item', dropdown =>
                this.#checkmark.visible = dropdown.selected_item === this.#color)
    }
    update(color) {
        this.#color = color
        this.#image.update(color.value)
        this.#label.label = color.label
        this.#checkmark.visible = this.dropdown?.selected_item === color
    }
})

GObject.registerClass({
    GTypeName: 'FoliateAnnotationColorDropDown',
    Signals: {
        'color-changed': { param_types: [GObject.TYPE_STRING] },
    },
}, class extends Gtk.DropDown {
    #prevSelected
    constructor(params) {
        super(params)
        this.model = utils.list([
            { label: _('Underline'), value: 'underline' },
            { label: _('Yellow'), value: 'yellow' },
            { label: _('Orange'), value: 'orange' },
            { label: _('Red'), value: 'red' },
            { label: _('Magenta'), value: 'magenta' },
            { label: _('Aqua'), value: 'aqua' },
            { label: _('Lime'), value: 'lime' },
            { label: _('Custom Color…'), type: 'choose' },
        ], AnnotationColor)

        this.factory = utils.connect(new Gtk.SignalListItemFactory(), {
            'setup': (_, listItem) => listItem.child = new AnnotationColorRow(),
            'bind': (_, { child, item }) => child.update(item),
        })

        this.list_factory = utils.connect(new Gtk.SignalListItemFactory(), {
            'setup': (_, listItem) =>
                listItem.child = new AnnotationColorRow({ dropdown: this }),
            'bind': (_, { child, item }) => child.update(item),
        })

        this.connect('notify::selected-item', () => {
            const selected = this.selected
            const item = this.selected_item
            if (item.type === 'choose') {
                const chooser = new Gtk.ColorChooserDialog({
                    modal: true,
                    transient_for: this.root,
                })
                chooser.show()
                chooser.connect('response', (_, res) => {
                    if (res === Gtk.ResponseType.OK) {
                        const color = chooser.get_rgba().to_string()
                        this.selectColor(color)
                        this.emit('color-changed', color)
                    } else this.selected = this.#prevSelected
                    chooser.close()
                })
            } else {
                this.emit('color-changed', item.value)
                this.#prevSelected = selected
            }
        })
    }
    selectColor(color) {
        const { model } = this
        for (const [i, item] of utils.gliter(model)) {
            if (item.value === color) {
                this.selected = i
                return
            }
            // if there's already an item for custom color, use it
            if (item.type === 'custom') {
                item.value = color
                this.selected = i
                return
            }
        }
        // create item for custom color
        const i = model.get_n_items() - 1
        model.insert(i, new AnnotationColor({
            label: _('Custom'),
            value: color,
            type: 'custom',
        }))
        this.selected = i
    }
})

export const AnnotationPopover = GObject.registerClass({
    GTypeName: 'FoliateAnnotationPopover',
    Template: pkg.moduleuri('ui/annotation-popover.ui'),
    Properties: utils.makeParams({
        'annotation': 'object',
    }),
    Signals: {
        'delete-annotation': {},
    },
    InternalChildren: ['stack', 'button', 'text-view', 'drop-down'],
}, class extends Gtk.Popover {
    #isAddingNote
    constructor(params) {
        super(params)
        this.insert_action_group('annotation', utils.addMethods(this, {
            actions: ['add-note', 'delete'],
        }))

        this._drop_down.selectColor(this.annotation.color)
        this._text_view.buffer.text = this.annotation.note
        this.#updateStack()

        this._drop_down.connect('color-changed', (_, color) =>
            this.annotation.set_property('color', color))
        this._text_view.buffer.connect('changed', buffer => {
            this.#updateStack()
            this.annotation.set_property('note', buffer.text)
        })
    }
    #updateStack() {
        const { buffer } = this._text_view
        this._stack.visible_child = this.#isAddingNote || buffer.text
            ? this._text_view.parent : this._button
        if (buffer.text) this.#isAddingNote = true
    }
    addNote() {
        this.#isAddingNote = true
        this._stack.visible_child = this._text_view.parent
        this._text_view.grab_focus()
    }
    delete() {
        this.emit('delete-annotation')
        this.popdown()
    }
})