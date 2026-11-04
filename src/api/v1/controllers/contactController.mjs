import * as enquiries from '../../../services/contact/enquiries.mjs';
import * as overview from '../../../services/studio/overview.mjs';

export const sendEnquiry = async (req, res) => {
    const { website, ...message } = req.body;
    // A bot filled the hidden field: it's told the message arrived, and nothing is kept.
    if (website) return res.status(201).json({ data: { status: 'received', id: '' } });
    res.status(201).json({ data: await enquiries.sendEnquiry(message) });
};

export const listEnquiries = async (req, res) => res.json({ data: await enquiries.listEnquiries() });
export const setEnquiryRead = async (req, res) => res.json({ data: await enquiries.setRead(req.params.id, req.body.read) });

export const getOverview = async (req, res) => res.json({ data: await overview.getOverview(req.admin) });
